import { describe, expect, test } from "bun:test";
import { PARK_END_OF_TURN_NUDGE } from "../src/turn-runner/prompts.js";
import { createTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

/**
 * Coverage for the end-of-turn park nudge.
 *
 * A park schedules no wake and runs nothing, so a turn that ends parked ends
 * the machine's forward motion until a human types again. That is correct when
 * the parent is genuinely waiting on the user, and a stall when the parent
 * simply forgot to transition — and only the parent can tell those apart. So
 * the runner spends one extra pass on a gentle nudge before the turn ends,
 * and takes whatever the parent decides.
 *
 * The two tests pin both directions: the nudge must reach a parent that can
 * still act on it, and it must not turn into a nag loop for a parent that
 * legitimately stays parked.
 */

function goalLoop(): StateMachineDefinition {
  return {
    name: "goal_loop",
    prompt: "Work, then evaluate, until the evaluator passes.",
    states: [
      { kind: "park", name: "work", when: "The main agent is doing the work." },
      { kind: "agent", name: "evaluate", prompt: "Judge the goal." },
      { kind: "terminal", name: "goal_met", status: "completed" },
    ],
  };
}

/** Prompts of every parent pass that carried the end-of-turn nudge. */
function nudgePasses(prompts: string[]): string[] {
  return prompts.filter((prompt) => prompt.includes(PARK_END_OF_TURN_NUDGE));
}

describe("end-of-turn park nudge", () => {
  test("reminds the parent once when a completed turn would end parked", async () => {
    const definition = goalLoop();
    const { runner } = createTurnRunner({ mode: definition });
    // Pass 1 parks at `work`; the turn would end there. The nudge pass gets
    // the parent moving again, and the machine reaches its terminal.
    runner.controlResults = [
      { type: "select_state_machine_state", decision: { state: "work" } },
      { type: "select_state_machine_state", decision: { state: "evaluate" } },
      // The state sub-agent's own pass: a worker emits no control action.
      { type: "none" },
      { type: "select_state_machine_state", decision: { state: "goal_met" } },
    ];

    const { turn } = await startTurn(runner, { mode: definition, prompt: "Reach the goal." });
    const terminal = await turn;

    const prompts = runner.workerInputs.map((input) => input.prompt);
    expect(nudgePasses(prompts)).toHaveLength(1);
    expect(terminal.state.stateMachine?.terminal).toMatchObject({
      state: "goal_met",
      status: "completed",
    });
  });

  test("does not nag a parent that stays parked with no work in between", async () => {
    const definition = goalLoop();
    const { runner } = createTurnRunner({ mode: definition });
    // The parent parks and, when reminded, deliberately stays parked. Nothing
    // ran in between, so it is waiting on the user — no second nudge.
    runner.controlResults = [
      { type: "select_state_machine_state", decision: { state: "work" } },
      { type: "none" },
    ];

    const { turn } = await startTurn(runner, { mode: definition, prompt: "Reach the goal." });
    const terminal = await turn;

    const prompts = runner.workerInputs.map((input) => input.prompt);
    expect(nudgePasses(prompts)).toHaveLength(1);
    expect(terminal.type).toBe("complete");
    expect(terminal.state.stateMachine?.currentState).toBe("work");
    expect(terminal.state.stateMachine?.terminal).toBeUndefined();
  });
});
