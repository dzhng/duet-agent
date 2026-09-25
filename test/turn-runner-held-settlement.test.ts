import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createOutreachStateMachine } from "./helpers/turn-runner-protocol.js";

/**
 * A state-machine state runs as a task, so the parent loop idles waiting for
 * activity while the state's agent works. Inside the state, the agent starts
 * a slow command that outlives its foreground budget (it moves to the
 * background) and then waits on another command in the foreground. The
 * background one settles first, while the foreground wait is still open.
 */
class HeldSettlementRunner extends TurnRunner {
  private workerCalls = 0;
  foregroundResult?: AgentToolResult<unknown>;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerCalls += 1;
    if (this.workerCalls === 1) {
      return {
        control: { type: "select_state_machine_state", decision: { state: "research_prospect" } },
        outcome: {
          type: "complete",
          status: "completed",
          result: "Selected research state.",
          state: { ...input.state, status: "completed" },
        },
      };
    }
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "Parent done.",
        state: {
          ...input.state,
          status: "completed",
          agent: { ...input.state.agent, status: "completed" },
        },
      },
    };
  }

  protected override createStateSubagentRun(): SubagentRun {
    return {
      prompt: async () => {
        const bash = this.createTools("agent").tools.find((tool) => tool.name === "bash");
        if (!bash) throw new Error("bash tool missing");
        // Outlives its 50ms budget, so it converts to a background task and
        // settles ~200ms later — while the next call is still waiting.
        await bash.execute("bg", { command: "sleep 0.25 && printf bg-done", timeout: 0.05 });
        this.foregroundResult = await bash.execute("fg", {
          command: "sleep 0.5 && printf fg-done",
          timeout: 5,
        });
        return { type: "complete", result: "State done." };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

describe("settlements held behind a foreground wait", () => {
  test(
    "a background settlement during a state's foreground wait does not stall the turn",
    async () => {
      const runner = new HeldSettlementRunner();
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      await runner.start({ type: "start", mode: createOutreachStateMachine() });

      const terminal = await runner.turn({
        type: "prompt",
        message: "Continue.",
        behavior: "follow_up",
      });

      expect(terminal.type).toBe("complete");
      expect(runner.foregroundResult?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("fg-done"),
      });
      const settled = events.filter((event) => event.type === "task_settled");
      expect(settled.map((event) => event.settlement.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      await runner.dispose();
    },
    { timeout: 10_000 },
  );
});

class CleanupSelectingRunner extends TurnRunner {
  carryIntoNextState = false;
  readonly cleanupStates: string[] = [];
  nextStateSawRunningPreview = false;
  private previewSelected = false;

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    let control: AgentWorkerResult["control"] = { type: "none" };
    if (!this.previewSelected) {
      this.previewSelected = true;
      control = { type: "select_state_machine_state", decision: { state: "preview" } };
    } else if (input.prompt.includes("background tasks are still running")) {
      const state = input.state.stateMachine?.currentState ?? "";
      this.cleanupStates.push(state);
      if (this.carryIntoNextState && state === "preview") {
        control = { type: "select_state_machine_state", decision: { state: "verify" } };
      } else {
        const task = this.taskManager.list().find((task) => task.status === "running");
        const stop = this.createTools("agent").tools.find((tool) => tool.name === "task_stop");
        if (!task || !stop) throw new Error("Missing preview task or stop tool");
        await stop.execute("stop-preview", { id: task.id });
        control = { type: "select_state_machine_state", decision: { state: "done" } };
      }
    }
    return {
      control,
      outcome: {
        type: "complete",
        status: "completed",
        result: "Preview complete",
        state: { ...input.state, status: "completed" },
      },
    };
  }

  protected override createStateSubagentRun(input: { state: StateMachineAgentState }): SubagentRun {
    return {
      prompt: async () => {
        if (input.state.name === "verify") {
          this.nextStateSawRunningPreview = this.taskManager
            .list()
            .some((task) => task.name === "bash" && task.status === "running");
          return { type: "complete", result: "Verified with preview still running" };
        }
        const bash = this.createTools("agent").tools.find((tool) => tool.name === "bash");
        if (!bash) throw new Error("Missing bash tool");
        await bash.execute("preview", { command: "sleep 60", run_in_background: true });
        return { type: "complete", result: "Preview ready" };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

test("a state selection during cleanup satisfies the pending relay transition", async () => {
  const runner = new CleanupSelectingRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  try {
    await runner.start({
      type: "start",
      mode: {
        name: "Preview",
        prompt: "Preview then done",
        states: [
          { kind: "agent", name: "preview", prompt: "Preview" },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
    const terminal = await runner.turn({ type: "prompt", message: "Start", behavior: "follow_up" });
    expect(terminal).toMatchObject({ type: "complete", status: "completed" });
    expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
    expect(terminal.state.stateMachine?.currentState).toBe("done");
  } finally {
    await runner.dispose();
  }
});

test("advancing with a running task reminds the parent again after the next worker finishes", async () => {
  const runner = new CleanupSelectingRunner({
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
  });
  runner.carryIntoNextState = true;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await runner.start({
      type: "start",
      mode: {
        name: "Preview across states",
        prompt: "Preview, verify, then clean up",
        states: [
          { kind: "agent", name: "preview", prompt: "Start preview" },
          { kind: "agent", name: "verify", prompt: "Use preview" },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
    const terminal = await Promise.race([
      runner.turn({ type: "prompt", message: "Start", behavior: "follow_up" }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("No cleanup opportunity after the next worker finished")),
          1000,
        );
      }),
    ]);
    expect(runner.nextStateSawRunningPreview).toBe(true);
    expect(runner.cleanupStates).toEqual(["preview", "verify"]);
    expect(terminal).toMatchObject({ type: "complete", status: "completed" });
    expect(terminal.state.tasks?.filter((task) => task.name === "bash")).toMatchObject([
      { status: "stopped" },
    ]);
    expect(terminal.state.stateMachine?.currentState).toBe("done");
  } finally {
    clearTimeout(watchdog);
    await runner.dispose();
  }
});
