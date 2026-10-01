import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnCommand, TurnEvent } from "../src/types/protocol.js";
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

class FinalizationRunner extends TurnRunner {
  constructor(
    private readonly firstOutcome:
      | "complete"
      | "ask"
      | "failure"
      | "memory_failure"
      | "cleanup_failure",
  ) {
    super(config);
    if (firstOutcome === "cleanup_failure") {
      this.taskManager.registerReaper(async () => {
        this.finalizationStarted = true;
        await this.finalizationGate;
      });
    }
  }
  readonly processed: string[] = [];
  finalizationStarted = false;
  releaseFinalization!: () => void;
  private readonly finalizationGate = new Promise<void>((resolve) => {
    this.releaseFinalization = resolve;
  });

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.processed.push(input.prompt);
    if (this.processed.length === 1) {
      if (this.firstOutcome === "failure" || this.firstOutcome === "cleanup_failure")
        throw new Error("parent failed before correction");
      if (this.firstOutcome === "ask") {
        return completedWorker(input, {
          type: "ask_user_question",
          questions: [{ question: "Please clarify", options: [{ label: "Continue" }] }],
        });
      }
    }
    return completedWorker(input, { type: "none" }, input.prompt);
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    if (this.finalizationStarted) return;
    this.finalizationStarted = true;
    await this.finalizationGate;
    if (this.firstOutcome === "memory_failure") throw new Error("memory observation failed");
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

class StopThenReplaceRunner extends TurnRunner {
  readonly stateRuns: Array<{ finish: () => void }> = [];
  private selected = false;

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (!this.selected) {
      this.selected = true;
      return completedWorker(input, {
        type: "select_state_machine_state",
        decision: { state: "work" },
      });
    }
    if (this.stateRuns.length === 2) {
      return completedWorker(
        input,
        input.state.stateMachine?.terminal
          ? { type: "none" }
          : { type: "select_state_machine_state", decision: { state: "done" } },
      );
    }
    const oldTask = this.taskManager.list().find((task) => task.status === "running");
    const stop = this.createTools("auto").tools.find((tool) => tool.name === "task_stop");
    if (!oldTask || !stop) throw new Error("Missing old worker or task_stop");
    await stop.execute("stop-old-worker", { id: oldTask.id });
    return completedWorker(input, {
      type: "create_state_machine_definition",
      definition: {
        ...runningAgentDefinition,
        name: "replacement",
        states: [
          ...runningAgentDefinition.states,
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
      firstState: "work",
    });
  }

  protected override createStateSubagentRun(): SubagentRun {
    let resolve!: (value: SubagentResult) => void;
    const result = new Promise<SubagentResult>((settle) => {
      resolve = settle;
    });
    this.stateRuns.push({
      finish: () => resolve({ type: "complete", result: "replacement finished" }),
    });
    return {
      prompt: () => result,
      interrupt: () => resolve({ type: "interrupted" }),
      partialAssistantText: () => undefined,
      interruptedReason: () => undefined,
    };
  }
}

describe("TurnRunner cutover seams", () => {
  test.each(["complete", "failure", "memory_failure", "cleanup_failure"] as const)(
    "a steer accepted during %s finalization runs before the shared terminal",
    async (outcome) => {
      const runner = new FinalizationRunner(outcome);
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      await runner.start({ type: "start" });
      const first = runner.turn({ type: "prompt", message: "initial request", behavior: "steer" });
      await waitFor(() => runner.finalizationStarted);
      let accepted = false;
      const correction = runner.turn(
        { type: "prompt", message: "persist the correction", behavior: "steer" },
        () => {
          accepted = true;
        },
      );
      await waitFor(() => accepted);
      runner.releaseFinalization();
      const [initialTerminal, correctionTerminal] = await Promise.all([first, correction]);
      expect(runner.processed).toEqual(["initial request", "persist the correction"]);
      expect(correctionTerminal).toBe(initialTerminal);
      expect(correctionTerminal).toMatchObject({
        type: "complete",
        status: "completed",
        result: "persist the correction",
      });
      expect(terminalEvents(events)).toHaveLength(1);
    },
  );

  test.each(["steer", "follow_up", "wake"] as const)(
    "%s accepted during question bookkeeping preserves the ask until resume",
    async (behavior) => {
      const command: TurnCommand =
        behavior === "wake"
          ? { type: "wake" }
          : { type: "prompt", message: "late input", behavior };
      const runner = new FinalizationRunner("ask");
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      await runner.start({ type: "start" });
      const first = runner.turn({ type: "prompt", message: "initial request", behavior: "steer" });
      await waitFor(() => runner.finalizationStarted);
      let accepted = false;
      const pending = runner.turn(command, () => {
        accepted = true;
      });
      await waitFor(() => accepted);
      runner.releaseFinalization();
      const [terminal, pendingTerminal] = await Promise.all([first, pending]);
      expect(pendingTerminal).toBe(terminal);
      expect(terminal).toMatchObject({
        type: "ask",
        questions: [{ question: "Please clarify", options: [{ label: "Continue" }] }],
      });
      expect(runner.processed).toEqual(["initial request"]);
      expect(terminal.state.queuedCommands).toEqual(command.type === "wake" ? [] : [command]);
      expect(terminalEvents(events)).toHaveLength(1);
      const resumed = await runner.turn({
        type: "prompt",
        message: "resume now",
        behavior: "steer",
      });
      expect(resumed).toMatchObject({
        type: "complete",
        status: "completed",
        result: "resume now",
      });
      expect(runner.processed).toEqual(
        command.type === "wake"
          ? ["initial request", "resume now"]
          : ["initial request", "late input", "resume now"],
      );
      expect(resumed.state.queuedCommands).toEqual([]);
    },
  );

  test("editing follow-ups during question finalization keeps them parked", async () => {
    const runner = new FinalizationRunner("ask");
    await runner.start({ type: "start" });
    const turn = runner.turn({ type: "prompt", message: "initial request", behavior: "steer" });
    await waitFor(() => runner.finalizationStarted);
    runner.editFollowUpQueue({
      type: "edit_follow_up_queue",
      prompts: [{ message: "parked follow-up" }],
    });
    runner.releaseFinalization();
    const terminal = await turn;
    expect(terminal.type).toBe("ask");
    expect(runner.processed).toEqual(["initial request"]);
    expect(terminal.state.queuedCommands).toEqual([
      { type: "prompt", message: "parked follow-up", behavior: "follow_up" },
    ]);
  });

  test("stopping an old worker before replacing its workflow does not interrupt the replacement", async () => {
    const runner = new StopThenReplaceRunner(config);
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: runningAgentDefinition });
    const turn = runner.turn({ type: "prompt", message: "start", behavior: "follow_up" });
    try {
      await waitFor(() => runner.stateRuns.length === 1);
      void runner.turn({
        type: "prompt",
        message: "stop the old worker and rebuild",
        behavior: "steer",
      });
      await waitFor(() => runner.stateRuns.length === 2);
      runner.stateRuns[1]!.finish();
      const terminal = await turn;
      expect(terminal).toMatchObject({ type: "complete", status: "completed" });
      expect(terminal.state.stateMachine?.definition.name).toBe("replacement");
      expect(
        terminal.state.stateMachine?.history.filter((entry) => entry.type === "state_interrupted"),
      ).toEqual([]);
      expect(events.filter((event) => event.type === "interrupted")).toEqual([]);
    } finally {
      await runner.dispose();
    }
  });

  test("state completions drive one transition pass without generic settlement notices", async () => {
    const { runner } = createTurnRunner();
    const definition: StateMachineDefinition = {
      name: "release_flow",
      prompt: "Collect release data, write the note, then finish.",
      states: [
        {
          kind: "script",
          name: "collect_release_data",
          command: `printf '{"version":"1.2.3"}'`,
        },
        {
          kind: "agent",
          name: "write_release_note",
          prompt: "Write the release note.",
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const workerInputs: AgentWorkerInput[] = [];
    runner.worker = async (input) => {
      workerInputs.push(input);
      if (input.prompt === "Write the release note.") {
        return completedWorker(input, { type: "none" }, "Release note written.");
      }

      if (input.prompt.includes("Prepare the release.")) {
        return completedWorker(input, {
          type: "create_state_machine_definition",
          definition,
          firstState: "collect_release_data",
        });
      }
      if (
        input.prompt.includes("<state_completed>") &&
        input.prompt.includes("collect_release_data")
      ) {
        return completedWorker(input, {
          type: "select_state_machine_state",
          decision: { state: "write_release_note" },
        });
      }
      if (
        input.prompt.includes("<state_completed>") &&
        input.prompt.includes("write_release_note")
      ) {
        return completedWorker(input, {
          type: "select_state_machine_state",
          decision: { state: "done" },
        });
      }
      return completedWorker(input, { type: "none" }, "Release flow complete.");
    };

    const terminal = await (await startTurn(runner, { prompt: "Prepare the release." })).turn;
    const parentInputs = workerInputs.filter((input) => input.prompt !== "Write the release note.");
    const transitionInputs = parentInputs.filter((input) =>
      input.prompt.includes("state_completed"),
    );
    const settlementInputs = parentInputs.filter((input) =>
      input.prompt.includes("settled while you were working"),
    );

    expect(transitionInputs.map((input) => input.prompt)).toEqual([
      expect.stringContaining('The state "collect_release_data" finished.'),
      expect.stringContaining('The state "write_release_note" finished.'),
    ]);
    expect(settlementInputs).toEqual([]);
    expect(workerInputs).toHaveLength(5);
    expect(
      terminal.state.stateMachine?.history
        .filter((entry) => entry.type === "state_completed")
        .map((entry) => entry.state),
    ).toEqual(["collect_release_data", "write_release_note"]);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { currentState: "done", terminalAcknowledged: true } },
    });
  });

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
      if (parentPass === 3) {
        return completedWorker(input, {
          type: "select_state_machine_state",
          decision: { state: "done" },
        });
      }
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

    // The gated ask produces no immediate reminder pass and no terminal; the
    // withheld question resurfaces on the parent's next pass after settlement.
    await waitFor(() => parentPass === 2);
    expect(
      parentPrompts.some((prompt) => prompt.includes("background tasks were still running")),
    ).toBe(false);
    expect(terminalEvents(events)).toEqual([]);

    resolveState();
    await waitFor(() =>
      parentPrompts.some((prompt) => prompt.includes("background tasks were still running")),
    );
    const heldAskPrompt = parentPrompts.find((prompt) =>
      prompt.includes("background tasks were still running"),
    );
    expect(heldAskPrompt).toContain("Premature?");
    expect(parentContinuations[parentPrompts.indexOf(heldAskPrompt ?? "")]).toBe(true);
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
