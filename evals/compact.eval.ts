import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { TurnEvent, TurnRunnerCommand, TurnTerminalEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Compact is the user-initiated wire-shaping command. The unit suite covers
 * the runner mechanics in isolation; this eval pins the end-to-end RPC
 * contract: `{type: "compact"}` lands on a live `duet --rpc` process, the
 * runner advances its sticky horizon, the terminal state carries the new
 * `wireGuardHorizon` object, and a downstream process can resume from
 * that state without losing the trim.
 *
 * `driveRpcLoop` exits the process after its single chain's terminal, so
 * "compact between turns" is modeled as: process A runs a turn and ends,
 * process B starts with A's state, dispatches `compact` while the runner
 * is hydrated-but-idle (before any prompt arrives), then runs the next
 * turn. The runner accepts out-of-band commands at any point inside the
 * loop, including before the first turn-driving command.
 */
describe("compact RPC command", () => {
  testIfDocker(
    "advances the wire-shaping horizon and round-trips through resume",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-compact-"));
      try {
        // Process 1: build a transcript with two turns so compact has
        // something to evict beyond MIN_HISTORY_TAIL. Both prompts arrive
        // before the chain's terminal so the runner queues them into the
        // same chain and emits one terminal carrying the full history.
        const built = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: "Reply with exactly: M1_OK_INTRO_MARKER",
              behavior: "follow_up",
            },
            {
              type: "prompt",
              message: "Reply with exactly: M2_OK",
              behavior: "follow_up",
            },
          ],
        );
        expect(built.exitCode).toBe(0);
        const builtTerminal = expectTerminal(built.events);
        expect(builtTerminal.type).toBe("complete");
        // A fresh session must not carry wireGuardHorizon: the
        // auto-trigger does not fire on a transcript this small, so the
        // snapshot pipeline omits the field. This pins the
        // "fresh-runner default stays schema-clean" contract.
        expect(builtTerminal.state.wireGuardHorizon).toBeUndefined();

        // Process 2: resume from process 1's state, send compact while
        // the runner is hydrated-but-idle, then drive a turn. Compact
        // runs before the chain starts (the loop processes out-of-band
        // commands inline between start and the first turn command),
        // so the next prompt's wire-tail already reflects the new
        // horizon.
        const compacted = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: builtTerminal.state },
            { type: "compact" },
            {
              type: "prompt",
              message: "Reply with exactly: M3_AFTER_COMPACT",
              behavior: "follow_up",
            },
          ],
        );
        expect(compacted.exitCode).toBe(0);
        // Compact must have reported a real eviction, not a no-op. The
        // success branch logs "compact: dropped N older wire message(s)";
        // the no-op branch logs "compact: nothing to evict". A no-op
        // here would mean the wire-tail couldn't shed any message
        // without violating MIN_HISTORY_TAIL, which would break the
        // assumption that two completed turns leave room to compact.
        const compactSystem = compacted.events.find(
          (event): event is Extract<TurnEvent, { type: "system" }> => isCompactSystemEvent(event),
        );
        expect(compactSystem, "expected a compact system event").toBeDefined();
        expect(compactSystem!.message).toMatch(/^compact: dropped \d+ older wire message/);

        const compactedTerminal = expectTerminal(compacted.events);
        expect(compactedTerminal.type).toBe("complete");
        const compactedHorizon = compactedTerminal.state.wireGuardHorizon;
        expect(compactedHorizon, "post-compact terminal must carry wireGuardHorizon").toBeDefined();
        expect(compactedHorizon!.evictionHorizon).toBeGreaterThan(0);

        // The durable transcript is preserved: the M1 marker from
        // process 1 still lives somewhere in `state.agent.messages`
        // after the compact. Compact is wire-shaping, not
        // transcript-mutation. JSON.stringify is the bluntest tool that
        // survives the AgentMessage union without teaching the eval
        // every variant shape.
        const transcriptJson = JSON.stringify(compactedTerminal.state.agent.messages);
        expect(transcriptJson).toContain("M1_OK_INTRO_MARKER");
        // Transcript must have grown across processes too.
        expect(compactedTerminal.state.agent.messages.length).toBeGreaterThan(
          builtTerminal.state.agent.messages.length,
        );

        // Process 3: resume from the post-compact state and drive
        // another turn. The wireGuardHorizon hydrated from state.json
        // must NOT regress to zero on this fresh runner; if it does,
        // a session compacted before the user exits the TUI ships the
        // full wire-tail again on next launch.
        const resumed = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: compactedTerminal.state },
            {
              type: "prompt",
              message: "Reply with exactly: M4_RESUMED",
              behavior: "follow_up",
            },
          ],
        );
        expect(resumed.exitCode).toBe(0);
        const resumedTerminal = expectTerminal(resumed.events);
        expect(resumedTerminal.type).toBe("complete");
        const resumedHorizon = resumedTerminal.state.wireGuardHorizon;
        expect(resumedHorizon, "resumed terminal must carry wireGuardHorizon").toBeDefined();
        // The auto-trigger or another compact pass could legally advance
        // the horizon again; it must not regress below the post-compact
        // value carried over from state.json.
        expect(resumedHorizon!.evictionHorizon).toBeGreaterThanOrEqual(
          compactedHorizon!.evictionHorizon,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function isCompactSystemEvent(event: TurnEvent): event is Extract<TurnEvent, { type: "system" }> {
  return (
    event.type === "system" &&
    typeof event.message === "string" &&
    event.message.startsWith("compact:")
  );
}

interface RpcSessionResult {
  exitCode: number;
  stderr: string;
  events: TurnEvent[];
}

/**
 * Spawn `duet --rpc` with `args`, feed the given commands to its stdin as
 * newline-delimited JSON, collect stdout events, and return the parsed
 * transcript. The runner queues turn-driving commands sent before the
 * first terminal into one chain, so multi-prompt setups land in a single
 * process exit.
 */
async function runRpcSession(
  args: string[],
  commands: TurnRunnerCommand[],
): Promise<RpcSessionResult> {
  // --no-skill-sync skips the duet.so default-skill fetch the CLI normally
  // runs at startup when DUET_API_KEY is set; unrelated to what this eval
  // asserts.
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await writeCommandsToStdin(proc, commands);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
  return { exitCode, stderr, events };
}

async function writeCommandsToStdin(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  commands: TurnRunnerCommand[],
): Promise<void> {
  const sink = proc.stdin;
  for (const command of commands) {
    sink.write(`${JSON.stringify(command)}\n`);
    await sink.flush();
  }
  await sink.end();
}

function expectTerminal(events: TurnEvent[]): TurnTerminalEvent {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  throw new Error(`No terminal event in RPC output. Saw: ${events.map((e) => e.type).join(",")}`);
}
