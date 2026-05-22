import { describe, expect } from "bun:test";
import dedent from "dedent";
import type { Subprocess } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Red eval: starting a second CLI while a first CLI is alive against a
 * shared memory directory must not throw the open-lock error from
 * `src/memory/pglite.ts → stealStaleLock`.
 *
 * Both CLIs run through the default (non-RPC) JSONL path so `SessionManager`
 * fills in `DEFAULT_MEMORY_DB_PATH` (`<HOME>/.duet/memory.db`) and
 * `loadStoredMemory → openMemoryDatabase → openPGlite → acquireOpenLock`
 * runs for real. With a shared `HOME` the two processes target the same
 * data dir.
 *
 * To overlap the two opens, CLI 1 is given a bash-sleep prompt so its
 * turn keeps the open-lock held for several seconds; CLI 2 launches in
 * that window. Today this fails with:
 *
 *   PGlite data directory <dir> is locked by another duet process (pid N)
 *
 * The fix should let the secondary CLI either share, wait for, or
 * gracefully degrade past the lock.
 */
describe("multi-CLI memory lock", () => {
  testIfDocker(
    "second CLI started while first is alive does not hit the pglite open-lock error",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "duet-multicli-home-"));
      const wd1 = await mkdtemp(join(tmpdir(), "duet-multicli-wd1-"));
      const wd2 = await mkdtemp(join(tmpdir(), "duet-multicli-wd2-"));

      let cli1: Subprocess<"ignore", "pipe", "pipe"> | undefined;
      let cli1Result: { stderr: string; events: TurnEvent[] } | undefined;
      try {
        // CLI 1: long-running prompt so the memory open-lock is held while
        // CLI 2 boots. A bash `sleep 25` keeps the turn (and the process)
        // alive for the entire CLI 2 startup path without depending on
        // anything model-specific beyond "use the bash tool".
        cli1 = spawnCli(
          [
            "--workdir",
            wd1,
            "--model",
            model,
            "--memory-model",
            model,
            dedent`
              Run this bash command exactly: \`sleep 25 && echo holding-lock\`.
              Pass a bash \`timeout\` argument of 60 so it is not killed by the default cap.
              When it finishes, reply with the single word DONE and nothing else.
            `,
          ],
          home,
        );

        // Wait for CLI 1 to make it past memory load. The first stdout
        // JSON event proves the runner has constructed itself, which means
        // `loadStoredMemory` already ran and the open-lock is held.
        const cli1FirstEvent = await waitForFirstEvent(cli1.stdout, 60_000);
        expect(
          cli1FirstEvent,
          "cli1 produced no events before timeout; cannot confirm lock is held",
        ).toBeDefined();

        // CLI 2: same HOME → same `~/.duet/memory.db` → same open-lock.
        cli1Result = collectCliOutput(cli1);
        const cli2Result = await runCliToCompletion(
          [
            "--workdir",
            wd2,
            "--model",
            model,
            "--memory-model",
            model,
            "Reply with the single word OK and nothing else.",
          ],
          home,
        );

        const lockErrorPattern =
          /PGlite data directory .* is locked by another duet process \(pid \d+\)/;
        expect(
          cli2Result.stderr,
          `expected no pglite open-lock error in cli2 stderr; got:\n${cli2Result.stderr}`,
        ).not.toMatch(lockErrorPattern);
        expect(cli2Result.exitCode, `cli2 stderr:\n${cli2Result.stderr}`).toBe(0);
        const cli2Terminal = findLastTerminal(cli2Result.events);
        expect(cli2Terminal?.type, `cli2 events: ${eventTypes(cli2Result.events)}`).toBe(
          "complete",
        );
      } finally {
        if (cli1) {
          try {
            cli1.kill("SIGKILL");
          } catch {
            // best-effort cleanup
          }
          if (cli1Result) {
            await cli1.exited;
          }
        }
        await rm(home, { recursive: true, force: true });
        await rm(wd1, { recursive: true, force: true });
        await rm(wd2, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

function spawnCli(args: string[], home: string): Subprocess<"ignore", "pipe", "pipe"> {
  // --no-skill-sync skips the duet.so default-skill fetch the CLI normally
  // runs at startup; unrelated to the multi-CLI memory.db lock contention
  // this eval is asserting.
  return Bun.spawn(["bun", "src/cli.ts", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
}

/**
 * Read from `stream` until a single line of JSON is parseable, then return
 * the parsed event. Cancels the read after `timeoutMs`. The reader is
 * released regardless so the caller can resume reading from the underlying
 * Subprocess stdout via another consumer.
 */
async function waitForFirstEvent(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<TurnEvent | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), remaining),
        ),
      ]);
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        if (line) {
          // Leave the rest of buffer to be re-read by the next consumer;
          // we have the proof we need.
          return JSON.parse(line) as TurnEvent;
        }
        buffer = buffer.slice(nl + 1);
      }
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Detach a background reader on the long-running CLI so its stdout/stderr
 * pipes do not fill and block the child. Returns a holder we can poke
 * after kill() to drain final bytes.
 */
function collectCliOutput(proc: Subprocess<"ignore", "pipe", "pipe">): {
  stderr: string;
  events: TurnEvent[];
} {
  const out = { stderr: "", events: [] as TurnEvent[] };
  void drainJsonLines(proc.stdout, (event) => out.events.push(event));
  void drainText(proc.stderr, (chunk) => {
    out.stderr += chunk;
  });
  return out;
}

async function drainJsonLines(
  stream: ReadableStream<Uint8Array>,
  sink: (event: TurnEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            sink(JSON.parse(line) as TurnEvent);
          } catch {
            // ignore non-JSON lines (boot banner etc.)
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function drainText(
  stream: ReadableStream<Uint8Array>,
  sink: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sink(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

async function runCliToCompletion(
  args: string[],
  home: string,
): Promise<{ exitCode: number; stderr: string; events: TurnEvent[] }> {
  const proc = spawnCli(args, home);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, events: parseJsonLines(stdout) };
}

function parseJsonLines(stdout: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as TurnEvent);
    } catch {
      // skip non-JSON banner lines
    }
  }
  return events;
}

function findLastTerminal(events: TurnEvent[]): TurnEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  return undefined;
}

function eventTypes(events: TurnEvent[]): string {
  return events.map((event) => event.type).join(",");
}
