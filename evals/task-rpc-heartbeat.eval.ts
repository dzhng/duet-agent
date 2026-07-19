import { describe, expect } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type {
  TurnEvent,
  TurnHeartbeatEvent,
  TurnRunnerCommand,
  TurnTerminalEvent,
} from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const EVENT_TIMEOUT_MS = 45_000;

type RpcWireEvent = TurnEvent;

describe("RPC task heartbeat", () => {
  testIfDocker(
    "keeps a held-open RPC turn observable without inventing an early terminal",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-rpc-heartbeat-"));
      const started = join(dir, "started");
      const pidFile = join(dir, "pid");
      const release = join(dir, "release");
      const stopped = join(dir, "stopped");
      const command = fixtureCommand({ started, pidFile, release, stopped });
      const rpc = spawnRpc(["--incognito", "--model", model]);

      try {
        await rpc.send({ type: "start", mode: "agent" });
        await rpc.send({
          type: "prompt",
          behavior: "follow_up",
          message:
            `Run this exact command with bash and run_in_background=true: \`${command}\`. ` +
            "Do not call task_output or task_stop. End the parent pass after the background " +
            "task starts. When its automatic settlement reminder arrives, reply exactly FIXTURE_DONE.",
        });

        const startedEvent = await rpc.waitFor(
          (event): event is Extract<TurnEvent, { type: "task_started" }> =>
            event.type === "task_started",
          EVENT_TIMEOUT_MS,
        );
        await waitForFile(started);

        // The host's liveness deadline is deliberately shorter than a useful gated task.
        // Falsification: remove periodic heartbeat emission in cli/rpc.ts and this await times
        // out while the fixture is still gated, rather than passing on eventual completion.
        const heartbeat = await rpc.waitFor(
          (event): event is TurnHeartbeatEvent => event.type === "heartbeat",
          EVENT_TIMEOUT_MS,
        );
        expect(heartbeat.timestamp).toBeGreaterThan(0);
        expect(startedEvent.task.status).toBe("running");
        expect(rpc.events.some(isTerminal)).toBe(false);

        await writeFile(release, "go\n");
        const terminal = await rpc.waitFor(isTerminal, EVENT_TIMEOUT_MS);
        const exitCode = await rpc.proc.exited;

        expect(exitCode).toBe(0);
        expect(terminal.type).toBe("complete");
        expect(rpc.events.filter(isTerminal)).toHaveLength(1);
        expect(eventIndex(rpc.events, "heartbeat")).toBeLessThan(
          eventIndex(rpc.events, "task_settled"),
        );
        expect(eventIndex(rpc.events, "task_settled")).toBeLessThan(
          rpc.events.findIndex(isTerminal),
        );
        // Heartbeats are transport liveness only; they must never become runner state.
        expect(JSON.stringify(terminal.state)).not.toContain('"type":"heartbeat"');
      } catch (error) {
        console.error(
          "HEARTBEAT_EVENT_DUMP",
          JSON.stringify(rpc.events.map((event) => event.type)),
        );
        throw error;
      } finally {
        rpc.killGroup();
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function fixtureCommand(paths: {
  started: string;
  pidFile: string;
  release: string;
  stopped: string;
}): string {
  return [
    "bun evals/fixtures/task-work.ts",
    `--started-file ${paths.started}`,
    `--pid-file ${paths.pidFile}`,
    `--release-file ${paths.release}`,
    `--stopped-file ${paths.stopped}`,
    "--stdout HEARTBEAT_FIXTURE_READY_4M7Q",
    "--stderr HEARTBEAT_FIXTURE_ERR_4M7Q",
  ].join(" ");
}

function eventIndex(events: readonly RpcWireEvent[], type: RpcWireEvent["type"]): number {
  const index = events.findIndex((event) => event.type === type);
  expect(
    index,
    `Expected RPC event ${type}; saw ${events.map((event) => event.type)}`,
  ).toBeGreaterThan(-1);
  return index;
}

function isTerminal(event: RpcWireEvent): event is TurnTerminalEvent {
  return ["complete", "ask", "interrupted", "sleep"].includes(event.type);
}

function spawnRpc(args: string[]): RpcHarness {
  // setsid gives the eval a private process group it can always reap without touching the
  // Docker test runner. This also models the cloud sandbox's process-group teardown boundary.
  const proc = Bun.spawn(["setsid", "bun", "src/cli.ts", "--rpc", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return new RpcHarness(proc);
}

class RpcHarness {
  readonly events: RpcWireEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly pump: Promise<void>;

  constructor(readonly proc: Subprocess<"pipe", "pipe", "pipe">) {
    this.pump = this.readEvents();
    void new Response(proc.stderr).text();
  }

  async send(command: TurnRunnerCommand): Promise<void> {
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
    await this.proc.stdin.flush();
  }

  async waitFor<T extends RpcWireEvent>(
    predicate: (event: RpcWireEvent) => event is T,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const match = this.events.find(predicate);
      if (match) return match;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for RPC event; saw: ${this.events.map((e) => e.type)}`);
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          this.waiters.add(resolve);
        }),
        Bun.sleep(Math.min(remaining, 250)),
        this.pump,
      ]);
    }
  }

  killGroup(): void {
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {
      // Already exited at the first terminal, which is the success path.
    }
  }

  private async readEvents(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) this.events.push(JSON.parse(line) as RpcWireEvent);
          newline = buffered.indexOf("\n");
        }
        this.notify();
        if (done) return;
      }
    } finally {
      reader.releaseLock();
      this.notify();
    }
  }

  private notify(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
