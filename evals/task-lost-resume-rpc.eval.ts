import { describe, expect } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type {
  TaskDescriptor,
  TurnEvent,
  TurnRunnerCommand,
  TurnState,
  TurnTerminalEvent,
} from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const EVENT_TIMEOUT_MS = 60_000;
const OUTPUT_SENTINEL = "RECOVERY_OUTPUT_TAIL_8K2P";

type RpcWireEvent = TurnEvent;

describe("RPC lost-task recovery", () => {
  testIfDocker(
    "kills a held-open process and resumes it as one explicit lost-task reminder",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-rpc-lost-resume-"));
      const statePath = join(dir, "host-persisted-state.json");
      const paths = {
        started: join(dir, "old.started"),
        pidFile: join(dir, "old.pid"),
        release: join(dir, "old.release"),
        stopped: join(dir, "old.stopped"),
      };
      const first = spawnRpc(["--incognito", "--model", model]);
      const processes = [first];

      try {
        await first.send({ type: "start", mode: "agent" });
        const initial = await first.waitFor(
          (event): event is Extract<TurnEvent, { type: "turn_started" }> =>
            event.type === "turn_started",
        );
        await first.send({
          type: "prompt",
          behavior: "follow_up",
          message:
            `Run this exact command with bash and run_in_background=true: \`${fixtureCommand(paths)}\`. ` +
            "Do not call task_output or task_stop. End the parent pass and wait for its automatic " +
            "settlement reminder before replying.",
        });
        const oldStarted = await first.waitFor(
          (event): event is Extract<TurnEvent, { type: "task_started" }> =>
            event.type === "task_started",
        );
        await waitForFile(paths.started);
        const oldPid = Number((await readFile(paths.pidFile, "utf8")).trim());
        const output = await first.waitFor(
          (event): event is Extract<TurnEvent, { type: "task_output" }> =>
            event.type === "task_output" &&
            event.taskId === oldStarted.task.id &&
            event.chunk.includes(OUTPUT_SENTINEL),
        );

        // RPC persistence is caller-owned. Model a real host by reducing the ordered event
        // stream into the latest TurnState and synchronously serializing the captured value.
        // Task output tails stay separate from lifecycle descriptors so recovery can show
        // useful context without turning buffered output into descriptor metadata.
        const projected = projectHostState(initial.state, oldStarted.task, output.chunk);
        await writeFile(statePath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
        const storedRunning = JSON.parse(await readFile(statePath, "utf8")) as TurnState;
        expect(storedRunning.status).toBe("running");
        expect(JSON.stringify(storedRunning)).toContain(OUTPUT_SENTINEL);
        expect(first.events.some(isTerminal)).toBe(false);

        // SIGKILL the sandbox process group: no graceful runner cleanup can manufacture a
        // settlement. Falsification: hydrate the descriptor as `running` unchanged and the
        // resumed turn_started/lost-reminder assertions below both turn red.
        first.killGroup();
        await first.proc.exited;
        // A SIGKILLed harness cannot reap its detached task groups (that is the
        // recorded v1 decision: orphan reaping needs the graceful shutdown path,
        // pinned by the cli-shutdown and slice-08 reaper tests). The fixture is
        // an orphan by design here; kill it explicitly as cleanup, not assertion.
        try {
          process.kill(oldPid, "SIGKILL");
        } catch {
          // already gone
        }
        await waitForProcessGone(oldPid);

        const second = spawnRpc(["--incognito", "--model", model]);
        processes.push(second);
        await second.send({ type: "start", mode: "agent", state: storedRunning });
        const resumed = await second.waitFor(
          (event): event is Extract<TurnEvent, { type: "turn_started" }> =>
            event.type === "turn_started",
        );
        expect(resumed.state.status).toBe("interrupted");
        expect(task(resumed.state, oldStarted.task.id).status).toBe("lost");

        await second.send({
          type: "prompt",
          behavior: "follow_up",
          message:
            "Start `printf NEW_TASK_AFTER_RECOVERY_6N3R` with bash and " +
            "run_in_background=true. Wait for its settlement reminder, then reply exactly RECOVERY_ACK.",
        });
        const newStarted = await second.waitFor(
          (event): event is Extract<TurnEvent, { type: "task_started" }> =>
            event.type === "task_started" && event.task.id !== oldStarted.task.id,
        );
        const recoveredTerminal = await second.waitFor(isTerminal);
        expect(await second.proc.exited).toBe(0);
        expect(taskNumber(newStarted.task.id)).toBeGreaterThan(taskNumber(oldStarted.task.id));
        expect(recoveredTerminal.state.nextTaskId).toBeGreaterThan(taskNumber(newStarted.task.id));

        const remindersAfterRecovery = lostReminderMessages(
          recoveredTerminal.state,
          oldStarted.task.id,
        );
        expect(remindersAfterRecovery).toHaveLength(1);
        expect(remindersAfterRecovery[0]).toContain(OUTPUT_SENTINEL);

        // A second resume plus parent pass proves "ONE" means once per recovered task, not once
        // per process. The previous reminder remains in history, but no new matching message lands.
        const third = spawnRpc(["--incognito", "--model", model]);
        processes.push(third);
        await third.send({ type: "start", mode: "agent", state: recoveredTerminal.state });
        await third.waitFor(
          (event): event is Extract<TurnEvent, { type: "turn_started" }> =>
            event.type === "turn_started",
        );
        await third.send({
          type: "prompt",
          behavior: "follow_up",
          message: "Reply exactly SECOND_RESUME_ACK. Do not use tools.",
        });
        const secondResumeTerminal = await third.waitFor(isTerminal);
        expect(await third.proc.exited).toBe(0);
        expect(lostReminderMessages(secondResumeTerminal.state, oldStarted.task.id)).toHaveLength(
          1,
        );
      } finally {
        for (const rpcProcess of processes) rpcProcess.killGroup();
        await rm(dir, { recursive: true, force: true });
      }
    },
    300_000,
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
    `--stdout ${OUTPUT_SENTINEL}`,
    "--stderr RECOVERY_STDERR_TAIL_8K2P",
  ].join(" ");
}

function task(state: TurnState, id: string): TaskDescriptor {
  const descriptor = state.tasks?.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`Missing task ${id} in resumed state`);
  return descriptor;
}

function taskNumber(id: string): number {
  return Number(id.slice(1));
}

/** Host-side event projection used because bare RPC deliberately owns no persistence policy. */
function projectHostState(
  initial: TurnState,
  descriptor: TaskDescriptor,
  outputTail: string,
): TurnState {
  return {
    ...structuredClone(initial),
    status: "running",
    tasks: [{ ...descriptor }],
    taskOutputTails: { [descriptor.id]: [outputTail] },
    nextTaskId: taskNumber(descriptor.id) + 1,
  };
}

function lostReminderMessages(state: TurnState, taskId: string): string[] {
  return state.agent.messages
    .map((message) => flattenText(message))
    .filter(
      (text) =>
        text.includes("<system-reminder>") &&
        text.toLowerCase().includes("lost") &&
        text.includes(taskId),
    );
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(flattenText)
      .join("\n");
  }
  return "";
}

function isTerminal(event: RpcWireEvent): event is TurnTerminalEvent {
  return ["complete", "ask", "interrupted", "sleep"].includes(event.type);
}

function spawnRpc(args: string[]): RpcHarness {
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
        new Promise<void>((resolve) => this.waiters.add(resolve)),
        Bun.sleep(Math.min(remaining, 250)),
        this.pump,
      ]);
    }
  }

  killGroup(): void {
    try {
      process.kill(-this.proc.pid, "SIGKILL");
    } catch {
      // The group is already gone.
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

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(25);
    } catch {
      return;
    }
  }
  throw new Error(`Old fixture process ${pid} survived sandbox SIGKILL`);
}
