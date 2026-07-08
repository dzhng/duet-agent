import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import {
  createTurnRunnerTools,
  type CurrentStateMachineStateResult,
} from "../src/turn-runner/tools.js";
import type {
  StateAgentHandle,
  StateAgentResult,
} from "../src/turn-runner/state-machine-controller.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "gpt-5.5";

/**
 * Regression eval for "executed state misread as a no-op".
 *
 * Real-session symptom (Kanban dev workflow, Monorepo board): the
 * `implementing` agent state genuinely ran — the runner recorded
 * state_started/state_completed for it and updated currentState — but the
 * sub-agent returned a MISLEADING, self-deprecating final result ("I don't
 * see a new request in this thread yet… what do you need?"). The
 * orchestrator took that self-report at face value, concluded "the
 * implementing sub-agent found nothing to build / it ran with no task", and
 * routed toward a no-op/cancel terminal WITHOUT reconciling against the live
 * executed state. The on-disk plan snapshot looking stale was a red herring;
 * the live runner state was correct the whole time and was never consulted.
 *
 * Two complementary tests:
 *
 *  - Test 1 (MODEL BEHAVIOR) reproduces the bug. A real TurnRunner drives a
 *    small plan -> implementing -> reviewing machine. The `implementing`
 *    sub-agent is mocked to COMPLETE with the misleading self-deprecating
 *    text. On the post-state decision turn the orchestrator must NOT cancel
 *    as "nothing ran"; it must treat implementing as executed — either by
 *    consulting live state (get_current_state_machine_state) or by advancing
 *    to the next real state. Reaching `reviewing`/`done` is only possible if
 *    the parent rejected the sub-agent's "nothing happened" claim, so the
 *    assertion can only hold under genuine reconciliation.
 *
 *  - Test 2 (DETERMINISTIC GUARD) pins the read-path invariant with no model
 *    in the loop: after selecting + running `implementing`, the live read
 *    (get_current_state_machine_state) and the session history must report
 *    the EXECUTED state (implementing + its completion), never the stale
 *    prior state (plan).
 */

// The concrete dev task is known and unambiguous up front, so the ONLY reason
// the orchestrator could believe "nothing happened" is the sub-agent's
// misleading self-report below — not any genuine absence of a task.
const CONCRETE_TASK =
  "Add a `--version` flag to the CLI that prints the package version from package.json and exits 0.";

const PLAN_RESULT = dedent`
  Spec: add a \`--version\` flag in src/cli.ts that reads the version field
  from package.json and prints it, then exits 0. Acceptance: \`cli --version\`
  prints the version string. Ready to implement.
`;

// The misleading, self-deprecating final result of a sub-agent that actually
// ran the state. The runner already recorded implementing as started and
// completed; this text is about the sub-agent's own confusion, not evidence
// that the state never executed.
const IMPLEMENTING_MISLEADING_RESULT = dedent`
  I don't see a new request in this thread yet — let me know what you'd
  like me to build and I'll get started.
`;

const CANCEL_TERMINAL = "wont do";

function buildDefinition(): StateMachineDefinition {
  return {
    name: "executed_state_eval",
    prompt: `Drive this dev request from plan through implementation to review: ${CONCRETE_TASK} Each agent state runs in its own sub-agent context.`,
    states: [
      { kind: "agent", name: "plan", prompt: "Clarify the request into an unambiguous spec." },
      {
        kind: "agent",
        name: "implementing",
        prompt: "Implement the change in a worktree and report what you changed.",
      },
      {
        kind: "agent",
        name: "reviewing",
        prompt: "Self-review the implemented diff and state the verdict.",
      },
      { kind: "terminal", name: "done", status: "completed", reason: "Work merged." },
      {
        kind: "terminal",
        name: CANCEL_TERMINAL,
        status: "cancelled",
        reason: "Nothing to do.",
      },
    ],
  };
}

/** Mocks named agent states with fixed completed results; others run for real. */
class MockedSubAgentRunner extends TurnRunner {
  private readonly fakeOutputs = new Map<string, string>();

  mockStateAgent(stateName: string, result: string): void {
    this.fakeOutputs.set(stateName, result);
  }

  protected override createStateAgentHandle(input: {
    state: StateMachineAgentState;
    prompt: string;
  }): StateAgentHandle {
    const fake = this.fakeOutputs.get(input.state.name);
    if (fake === undefined) return super.createStateAgentHandle(input);
    let interruptedReason: string | undefined;
    return {
      prompt: async (): Promise<StateAgentResult> => {
        if (interruptedReason !== undefined) return { type: "interrupted" };
        return { type: "complete", result: fake };
      },
      interrupt: (reason) => {
        interruptedReason = reason;
      },
      partialAssistantText: () => fake,
      interruptedReason: () => interruptedReason,
    };
  }
}

interface DecisiveTurnResult {
  selectStates: string[];
  consultedLiveState: boolean;
  parentText: string;
}

async function runDecisiveTurn(): Promise<DecisiveTurnResult> {
  const definition = buildDefinition();
  const runner = new MockedSubAgentRunner({
    model,
    mode: definition,
    skillDiscovery: { includeDefaults: false },
    systemInstructions: dedent`
      This is a live eval. The user has given a concrete, unambiguous dev
      task: ${CONCRETE_TASK} Use the state-machine tools for every
      transition. The \`plan\` state already produced the spec, so begin by
      selecting the \`implementing\` state to do the work. When a state
      finishes, decide the next transition yourself based on what actually
      happened. Do not ask the user any questions.
    `,
  });
  // plan/reviewing are mocked so an advance is cheap and deterministic; the
  // decisive signal is what the parent does after `implementing` completes.
  runner.mockStateAgent("plan", PLAN_RESULT);
  runner.mockStateAgent("implementing", IMPLEMENTING_MISLEADING_RESULT);
  runner.mockStateAgent("reviewing", "Reviewed the diff; verdict clean.");

  const selectStates: string[] = [];
  let consultedLiveState = false;
  const parentText: string[] = [];

  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    // Only watch the parent orchestrator. Sub-agent steps carry an origin tag.
    if (event.origin) return;
    const step = event.step;
    if (step.type === "text") {
      parentText.push(step.text);
      return;
    }
    if (step.type !== "tool_call_start") return;
    if (step.toolName === "get_current_state_machine_state") {
      consultedLiveState = true;
      return;
    }
    if (step.toolName === "select_state_machine_state") {
      const stateName = step.input?.decision?.state;
      if (typeof stateName === "string") selectStates.push(stateName);
    }
  });

  const started = await startTurn(runner, {
    mode: definition,
    prompt: `Run the dev workflow for this task: ${CONCRETE_TASK} The plan/spec is done — select the implementing state to build it.`,
  });
  await started.turn;

  return { selectStates, consultedLiveState, parentText: parentText.join("\n") };
}

describe("executed state is not misread as a no-op", () => {
  // Model-dependent, so run a few trials; green requires every trial to
  // reconcile, and the falsification only needs one trial to cancel.
  const TRIALS = Number(process.env.EVAL_EXECUTED_STATE_TRIALS ?? 2);

  testIfDocker(
    "parent reconciles executed implementing state instead of cancelling as 'nothing ran'",
    async () => {
      const failures: Array<{ trial: number } & DecisiveTurnResult> = [];

      for (let trial = 1; trial <= TRIALS; trial++) {
        const result = await runDecisiveTurn();

        const cancelledNoOp = result.selectStates.includes(CANCEL_TERMINAL);
        // Reaching reviewing/done can only happen if the parent treated
        // implementing as executed and moved past the sub-agent's "nothing
        // happened" claim. Consulting live state is direct reconciliation.
        const advancedForward =
          result.selectStates.includes("reviewing") || result.selectStates.includes("done");
        const reconciled = result.consultedLiveState || advancedForward;

        if (cancelledNoOp || !reconciled) {
          failures.push({ trial, ...result });
        }
      }

      if (failures.length > 0) {
        // Surface what the parent actually did so the red diagnostic points at
        // the real path (cancel-as-no-op vs. failure to reconcile).
        console.log("diagnostic (executed-state-not-no-op):", JSON.stringify(failures, null, 2));
      }
      expect(failures).toEqual([]);
    },
    600_000,
  );

  test("live read reports the executed state, not the stale prior state", async () => {
    const definition = buildDefinition();
    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: () => ({
        prompt: async (): Promise<StateAgentResult> => ({
          type: "complete",
          result: IMPLEMENTING_MISLEADING_RESULT,
        }),
        interrupt: () => {},
        partialAssistantText: () => IMPLEMENTING_MISLEADING_RESULT,
        interruptedReason: () => undefined,
      }),
    });

    // Seed the session parked on the prior state (`plan`) — the stale snapshot
    // the buggy orchestrator trusted instead of the live executed state.
    controller.startSession({ prompt: definition.prompt, definition, currentState: "plan" });

    // Execute `implementing`. Its sub-agent returns the misleading
    // self-deprecating result, but the state genuinely ran.
    await controller.runDecision({ state: "implementing" });

    const live = await readLiveState(controller, definition);

    // The live read must report the EXECUTED state, never the stale `plan`.
    expect(live.currentState).toBe("implementing");

    // And the history must record implementing as completed (executed), so the
    // orchestrator can reconcile even when the sub-agent's text claims nothing
    // happened.
    const history = live.history ?? [];
    const implementingCompleted = history.find(
      (event): event is Extract<StateMachineSessionEvent, { type: "state_completed" }> =>
        event.type === "state_completed" && event.state === "implementing",
    );
    expect(implementingCompleted).toBeTruthy();
  });
});

async function readLiveState(
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
