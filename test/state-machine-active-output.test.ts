import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import {
  createTurnRunnerTools,
  type CurrentStateMachineStateResult,
} from "../src/turn-runner/tools.js";
import type { StateAgentResult } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

describe("state-machine active output", () => {
  test("returns active agent partial assistant text", async () => {
    const deferred = createDeferred<StateAgentResult>();
    let assistantText: string | undefined = "drafting research";
    const definition: StateMachineDefinition = {
      name: "agent-output",
      prompt: "Run agent.",
      states: [{ kind: "agent", name: "research", prompt: "Research." }],
    };
    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: () => ({
        prompt: () => deferred.promise,
        interrupt: () => deferred.resolve({ type: "interrupted" }),
        partialAssistantText: () => assistantText,
      }),
    });
    controller.startSession({ prompt: "Run agent.", definition, currentState: "research" });

    const run = controller.runDecision({ kind: "run_state", state: "research" });
    try {
      await waitFor(() => controller.hasActiveWork());

      const details = await inspect(controller, definition);
      expect(details.activeOutput).toEqual({
        state: "research",
        kind: "agent",
        output: { assistantText: "drafting research" },
      });
    } finally {
      assistantText = undefined;
      deferred.resolve({ type: "complete", result: "done" });
      await run;
    }
  });

  test("returns active script stdout and stderr", async () => {
    const definition: StateMachineDefinition = {
      name: "script-output",
      prompt: "Run script.",
      states: [
        {
          kind: "script",
          name: "send",
          command: "printf script-out; printf script-err >&2; sleep 30",
        },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Run script.", definition, currentState: "send" });

    const run = controller.runDecision({ kind: "run_state", state: "send" });
    try {
      await waitFor(() => {
        const output = controller.getActiveOutput();
        return (
          output?.kind === "script" &&
          output.output?.stdout.includes("script-out") &&
          output.output?.stderr.includes("script-err")
        );
      });

      const details = await inspect(controller, definition);
      expect(details.activeOutput).toEqual({
        state: "send",
        kind: "script",
        output: { stdout: "script-out", stderr: "script-err" },
      });
    } finally {
      controller.interrupt();
      await run;
    }
  });

  test("returns active poll stdout and stderr", async () => {
    const definition: StateMachineDefinition = {
      name: "poll-output",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "wait",
          intervalMs: 60_000,
          command: "printf poll-out; printf poll-err >&2; sleep 30",
        },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Poll.", definition, currentState: "wait" });

    const run = controller.runDecision({ kind: "run_state", state: "wait" });
    try {
      await waitFor(() => {
        const output = controller.getActiveOutput();
        return (
          output?.kind === "poll" &&
          output.output?.stdout.includes("poll-out") &&
          output.output?.stderr.includes("poll-err")
        );
      });

      const details = await inspect(controller, definition);
      expect(details.activeOutput).toEqual({
        state: "wait",
        kind: "poll",
        output: { stdout: "poll-out", stderr: "poll-err" },
      });
    } finally {
      controller.interrupt();
      await run;
    }
  });

  test("omits activeOutput when no state is running", async () => {
    const definition: StateMachineDefinition = {
      name: "idle",
      prompt: "Done.",
      states: [{ kind: "terminal", name: "done", status: "completed" }],
    };
    const controller = createController();
    controller.startSession({ prompt: "Done.", definition, currentState: "done" });

    const details = await inspect(controller, definition);
    expect(details.activeOutput).toBeUndefined();
    expect("activeOutput" in details).toBe(false);
  });
});

function createController(): StateMachineController {
  return new StateMachineController({
    cwd: process.cwd(),
    createStateAgent: () => {
      throw new Error("Unexpected state agent.");
    },
  });
}

async function inspect(
  controller: StateMachineController,
  definition: StateMachineDefinition,
): Promise<CurrentStateMachineStateResult> {
  const tool = createTurnRunnerTools({
    cwd: process.cwd(),
    mode: definition,
    getStateMachine: () => controller.getSession(),
    getActiveStateOutput: () => controller.getActiveOutput(),
    todoStorage: {
      getTodos: () => [],
      setTodos: () => {},
    },
  }).find((candidate) => candidate.name === "get_current_state_machine_state");

  assert(tool, "get_current_state_machine_state tool missing");
  const result = await tool.execute("tool-1", {});
  return result.details as CurrentStateMachineStateResult;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean | undefined): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
