import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { delay } from "./helpers/async.js";

class AsyncSurfaceRunner extends TurnRunner {
  readonly workerInputs: AgentWorkerInput[] = [];

  /** Descriptor snapshots for assertions (kernel `list()` is scope-filtered copies). */
  taskDescriptors() {
    return this.taskManager.list();
  }
  backgroundStart?: AgentToolResult<unknown>;
  command = "sleep 0.05 && printf task-finished";

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerInputs.push(input);
    if (this.workerInputs.length === 1) {
      const bash = this.createTools("agent").tools.find((tool) => tool.name === "bash");
      if (!bash) throw new Error("bash tool missing");
      this.backgroundStart = await bash.execute("bash-1", {
        command: this.command,
        run_in_background: true,
      });
    }
    const result = this.workerInputs.length === 1 ? "parent idle" : "settlement handled";
    const assistant = createAssistantMessage({ text: result });
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result,
        state: {
          ...input.state,
          status: "completed",
          agent: {
            status: "completed",
            messages: [...input.state.agent.messages, assistant],
          },
        },
      },
    };
  }
}

class ObserverCadenceRunner extends TurnRunner {
  readonly workerInputs: AgentWorkerInput[] = [];
  observerRuns = 0;

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerInputs.push(input);
    if (this.workerInputs.length === 1) {
      this.startFixtureTask("first", 5);
      this.startFixtureTask("second", 50);
    }
    const result = `pass-${this.workerInputs.length}`;
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result,
        state: {
          ...input.state,
          status: "completed",
          agent: {
            status: "completed",
            messages: [...input.state.agent.messages, createAssistantMessage({ text: result })],
          },
        },
      },
    };
  }

  private startFixtureTask(name: string, delayMs: number): void {
    this.taskManager.start({
      kind: "tool",
      name: "fixture",
      label: name,
      ownerScopeId: "root",
      execute: async () => {
        await delay(delayMs);
        return `${name} done`;
      },
    });
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    this.observerRuns += 1;
  }
}

describe("TurnRunner async task surface", () => {
  test("holds the terminal until background bash settles and re-prompts as a continuation", async () => {
    const runner = new AsyncSurfaceRunner({
      model: "anthropic:claude-opus-4-7",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "run background work" })
    ).turn;

    expect(runner.backgroundStart?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Started background task t1"),
    });
    expect(runner.workerInputs).toHaveLength(2);
    expect(runner.workerInputs[1]).toMatchObject({
      continuation: true,
      prompt: expect.stringContaining("1 task settled while you were working"),
    });
    expect(terminal).toMatchObject({ type: "complete", result: "settlement handled" });

    const lifecycle = events
      .filter((event) =>
        ["task_started", "task_output", "task_settled", "complete"].includes(event.type),
      )
      .map((event) => event.type);
    expect(lifecycle[0]).toBe("task_started");
    expect(lifecycle).toContain("task_output");
    expect(lifecycle.indexOf("task_settled")).toBeLessThan(lifecycle.indexOf("complete"));
    expect(terminal.state.tasks).toMatchObject([{ id: "t1", kind: "tool", status: "completed" }]);
    expect(terminal.state.nextTaskId).toBe(2);
    await runner.dispose();
  });

  test("observes once after multiple settlement continuations instead of once per parent pass", async () => {
    const runner = new ObserverCadenceRunner({
      model: "anthropic:claude-opus-4-7",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });

    await (
      await startTurn(runner, { mode: "agent", prompt: "run background work" })
    ).turn;

    expect(runner.workerInputs).toHaveLength(3);
    expect(runner.observerRuns).toBe(1);
    // Falsification: invoke updateMemoryAfterAgentRun after each loop input. This count becomes
    // four (three parent passes plus quiescence), proving the assertion rejects pass cadence.
    await runner.dispose();
  });

  testIfDocker(
    "dispose reaps the detached process group before returning",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-reaper-"));
      const started = join(dir, "started");
      const pidFile = join(dir, "pid");
      const stopped = join(dir, "stopped");
      const runner = new AsyncSurfaceRunner({
        model: "anthropic:claude-opus-4-7",
        mode: "agent",
        cwd: process.cwd(),
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      });
      runner.command = `bun evals/fixtures/task-work.ts --started-file ${started} --pid-file ${pidFile} --release-file ${join(dir, "release")} --stopped-file ${stopped} --stdout running --stderr none`;
      const active = (await startTurn(runner, { mode: "agent", prompt: "start orphan probe" }))
        .turn;
      for (let attempt = 0; attempt < 3_000; attempt += 1) {
        if (
          await access(started).then(
            () => true,
            () => false,
          )
        )
          break;
        await delay(10);
      }
      const pid = Number((await readFile(pidFile, "utf8")).trim());

      // Docker falsification target: omit taskManager.reapAll/interruptAll from dispose; the PID
      // probe must remain alive and this test must turn red.
      await runner.dispose();
      await active;
      // pi's bash abort SIGKILLs the process group immediately, so the fixture
      // cannot record a SIGTERM marker (graceful TERM-first for bash children is
      // deferred; see spec README sharp edges). The contract proven here is
      // liveness: the group is dead and the task settled as stopped.
      expect(() => process.kill(pid, 0)).toThrow();
      const settled = runner.taskDescriptors().find((task) => task.kind === "tool");
      expect(settled?.status).toBe("stopped");
    },
    30_000,
  );
});
