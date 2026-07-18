import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import type { SubagentResult, SubagentRun } from "../src/turn-runner/subagent.js";
import { waitFor } from "./helpers/async.js";
import { createTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";

const config = {
  model: "anthropic:claude-opus-4-7",
  mode: "auto" as const,
  memoryDbPath: false as const,
};

const runningAgentDefinition: StateMachineDefinition = {
  name: "ask_gate",
  prompt: "Run work before asking the user.",
  states: [{ kind: "agent", name: "work", prompt: "Do the work." }],
};

class CutoverRunner extends TurnRunner {
  controlTools(): AgentTool[] {
    return this.createTools("auto").tools.filter((tool) =>
      [
        "ask_user_question",
        "select_state_machine_state",
        "create_state_machine_definition",
      ].includes(tool.name),
    );
  }

  capture(result: TurnRunnerControlResult): void {
    (
      this as unknown as {
        captureParentControlResult(value: TurnRunnerControlResult): void;
      }
    ).captureParentControlResult(result);
  }
}

class ThrowingPassRunner extends TurnRunner {
  protected override async runAgentWorker(): Promise<AgentWorkerResult> {
    throw new Error("injected parent-pass failure");
  }
}

class ReplacementProbeRunner extends TurnRunner {
  stateRuns = 0;

  stateTaskCount(): number {
    return (this as unknown as { stateTasks: Map<unknown, unknown> }).stateTasks.size;
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    return completedWorker(input, {
      type: "select_state_machine_state",
      decision: { state: "work" },
    });
  }

  protected override createStateSubagentRun(): SubagentRun {
    this.stateRuns += 1;
    let resolve!: (result: SubagentResult) => void;
    const result = new Promise<SubagentResult>((settle) => {
      resolve = settle;
    });
    let interruptedReason: string | undefined;
    return {
      prompt: () => result,
      interrupt: (reason) => {
        interruptedReason = reason;
        resolve({ type: "interrupted" });
      },
      partialAssistantText: () => undefined,
      interruptedReason: () => interruptedReason,
    };
  }
}

describe("TurnRunner cutover seams", () => {
  test("holds a steered ask until active state work settles", async () => {
    const { runner, events } = createTurnRunner();
    let resolveState!: () => void;
    const stateFinished = new Promise<void>((resolve) => {
      resolveState = resolve;
    });
    const parentPrompts: string[] = [];
    const parentContinuations: Array<boolean | undefined> = [];
    let parentPass = 0;
    runner.worker = async (input) => {
      if (input.state.mode === "agent") {
        await stateFinished;
        return completedWorker(input, { type: "none" }, "state complete");
      }
      parentPrompts.push(input.prompt);
      parentContinuations.push(input.continuation);
      parentPass += 1;
      if (parentPass === 1) {
        return completedWorker(input, {
          type: "select_state_machine_state",
          decision: { state: "work" },
        });
      }
      if (parentPass === 2) {
        return completedWorker(input, {
          type: "ask_user_question",
          questions: [{ question: "Premature?", options: [{ label: "Yes" }] }],
        });
      }
      if (parentPass === 3) return completedWorker(input, { type: "none" });
      return completedWorker(input, {
        type: "ask_user_question",
        questions: [{ question: "Ready now?", options: [{ label: "Yes" }] }],
      });
    };

    const { turn } = await startTurn(runner, {
      mode: runningAgentDefinition,
      prompt: "start",
    });
    await waitFor(() => runner.stateAgentInputs.length === 1);
    const steered = runner.turn({ type: "prompt", message: "ask me", behavior: "steer" });

    await waitFor(() => parentPrompts.some((prompt) => prompt.includes("NOT delivered")));
    const heldAskPrompt = parentPrompts.find((prompt) => prompt.includes("NOT delivered"));
    expect(heldAskPrompt).toContain("task_output");
    expect(heldAskPrompt).toContain("task_stop");
    expect(parentContinuations[parentPrompts.indexOf(heldAskPrompt ?? "")]).toBe(true);
    expect(terminalEvents(events)).toEqual([]);

    resolveState();
    const [terminal, steeredTerminal] = await Promise.all([turn, steered]);
    expect(steeredTerminal).toBe(terminal);
    expect(terminal).toMatchObject({
      type: "ask",
      questions: [{ question: "Ready now?" }],
    });
  });

  test("does not carry interrupted task settlements into the next turn", async () => {
    const { runner } = createTurnRunner();
    let resolveState!: () => void;
    const stateFinished = new Promise<void>((resolve) => {
      resolveState = resolve;
    });
    let parentPass = 0;
    let parentThrew = false;
    runner.worker = async (input) => {
      if (input.state.mode === "agent") {
        await stateFinished;
        return completedWorker(input, { type: "none" }, "state unwound");
      }
      parentPass += 1;
      if (parentPass === 1) {
        return completedWorker(input, {
          type: "select_state_machine_state",
          decision: { state: "work" },
        });
      }
      if (parentPass === 2) {
        parentThrew = true;
        throw new Error("injected steer failure");
      }
      return completedWorker(input, { type: "none" }, "next turn completed");
    };

    const { turn } = await startTurn(runner, {
      mode: runningAgentDefinition,
      prompt: "start",
    });
    await waitFor(() => runner.stateAgentInputs.length === 1);
    const failedSteer = runner.turn({
      type: "prompt",
      message: "trigger failure",
      behavior: "steer",
    });
    await waitFor(() => parentThrew);
    resolveState();

    const [failed, sameFailed] = await Promise.all([turn, failedSteer]);
    expect(sameFailed).toBe(failed);
    expect(failed).toMatchObject({
      type: "complete",
      status: "failed",
      error: "injected steer failure",
    });

    const next = await runner.turn({
      type: "prompt",
      message: "clean next turn",
      behavior: "follow_up",
    });
    expect(next).toMatchObject({
      type: "complete",
      status: "completed",
      result: "next turn completed",
    });
    expect(
      runner
        .getState()
        ?.stateMachine?.history.filter((entry) => entry.type === "state_interrupted"),
    ).toEqual([]);
  });

  test("repeated state replacements release ignored task metadata", async () => {
    const runner = new ReplacementProbeRunner(config);
    await runner.start({ type: "start", mode: runningAgentDefinition });
    const turn = runner.turn({ type: "prompt", message: "start", behavior: "follow_up" });
    await waitFor(() => runner.stateRuns === 1);

    for (let replacement = 1; replacement <= 4; replacement += 1) {
      void runner.turn({
        type: "prompt",
        message: `replacement ${replacement}`,
        behavior: "steer",
      });
      await waitFor(() => runner.stateRuns === replacement + 1);
      await waitFor(() => runner.stateTaskCount() === 1);
    }

    expect(runner.stateTaskCount()).toBe(1);
    runner.interrupt({ type: "interrupt" });
    expect(await turn).toMatchObject({ type: "interrupted" });
  });

  test("two control tools in one batch are sequential and the second capture is rejected", async () => {
    const runner = new CutoverRunner(config);
    await runner.start({ type: "start" });

    expect(runner.controlTools().map((tool) => tool.executionMode)).toEqual([
      "sequential",
      "sequential",
      "sequential",
    ]);
    runner.capture({
      type: "ask_user_question",
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
    });
    expect(() =>
      runner.capture({
        type: "ask_user_question",
        questions: [{ question: "Really?", options: [{ label: "Yes" }] }],
      }),
    ).toThrow("more than one control result");
  });

  test("interrupt emits one terminal when the parent has already unwound", async () => {
    const runner = new TurnRunner(config);
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });

    runner.interrupt({ type: "interrupt" });
    await waitFor(() => events.some((event) => event.type === "interrupted"));

    expect(events.filter((event) => event.type === "interrupted")).toHaveLength(1);
  });

  test("a thrown parent pass still emits exactly one failed terminal", async () => {
    const runner = new ThrowingPassRunner(config);
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });

    const terminal = await runner.turn({
      type: "prompt",
      message: "trigger the injected throw",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: "injected parent-pass failure",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "complete" ||
          event.type === "ask" ||
          event.type === "sleep" ||
          event.type === "interrupted",
      ),
    ).toHaveLength(1);
  });
});

function completedWorker(
  input: AgentWorkerInput,
  control: TurnRunnerControlResult,
  result = "done",
): AgentWorkerResult {
  return {
    control,
    outcome: {
      type: "complete",
      status: "completed",
      result,
      state: {
        ...input.state,
        status: "completed",
        agent: { ...input.state.agent, status: "completed" },
      },
    },
  };
}

function terminalEvents(events: readonly TurnEvent[]): TurnEvent[] {
  return events.filter((event) => ["complete", "ask", "sleep", "interrupted"].includes(event.type));
}
