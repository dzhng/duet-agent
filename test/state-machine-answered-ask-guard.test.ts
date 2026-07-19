import { describe, expect, test } from "bun:test";
import { currentParkState } from "../src/turn-runner/state-machine-session.js";
import type { StateMachineDefinition, StateMachineSession } from "../src/types/state-machine.js";
import { createTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";

function parkDefinition(): StateMachineDefinition {
  return {
    name: "parent_owned_gate",
    prompt: "Wait for the user's approval before continuing.",
    states: [
      { kind: "park", name: "await_approval", when: "Approval has not arrived yet." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function parkedSession(): StateMachineSession {
  return {
    definition: parkDefinition(),
    prompt: "Wait for approval.",
    currentState: "await_approval",
    history: [{ type: "state_started", timestamp: 1, state: "await_approval" }],
    createdAt: 0,
    updatedAt: 1,
  };
}

describe("currentParkState", () => {
  test("returns the inert current park while the machine is active", () => {
    expect(currentParkState(parkedSession())?.name).toBe("await_approval");
  });

  test("returns undefined for a terminal machine", () => {
    const session = parkedSession();
    session.terminal = { state: "done", status: "completed" };
    expect(currentParkState(session)).toBeUndefined();
  });
});

describe("parent-owned park gate", () => {
  test("state agents do not receive ask_user_question", async () => {
    const { runner } = createTurnRunner();
    await runner.start({ type: "start", mode: parkDefinition() });
    expect(runner.childToolNames()).not.toContain("ask_user_question");
  });

  test("selecting park starts no task and leaves the machine parked", async () => {
    const { runner, events } = createTurnRunner();
    const definition = parkDefinition();
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { state: "await_approval" },
    });

    const terminal = await (await startTurn(runner, { mode: definition, prompt: "Begin." })).turn;

    expect(terminal.type).toBe("complete");
    expect(terminal.state.stateMachine?.currentState).toBe("await_approval");
    expect(terminal.state.stateMachine?.history.at(-1)).toMatchObject({
      type: "state_started",
      state: "await_approval",
    });
    expect(terminal.state.stateMachine?.progress?.states.await_approval?.runs).toBe(1);
    expect(events.filter((event) => event.type === "task_started")).toEqual([]);
  });

  test("the parent asks while parked and a later answer drives the transition", async () => {
    const { runner } = createTurnRunner();
    const definition = parkDefinition();
    const questions = [
      { question: "Deploy now?", options: [{ label: "Go ahead" }, { label: "Wait" }] },
    ];
    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "await_approval" } },
      { type: "ask_user_question", questions },
      { type: "select_state_machine_state", decision: { state: "done" } },
    );

    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;
    const asked = await runner.turn({
      type: "prompt",
      message: "Ask me before deploying.",
      behavior: "follow_up",
    });
    expect(asked.type).toBe("ask");
    expect(asked.state.stateMachine?.currentState).toBe("await_approval");

    const terminal = await runner.turn({
      type: "answer",
      questions,
      answers: { "Deploy now?": ["Go ahead"] },
      behavior: "follow_up",
    });
    expect(terminal.state.stateMachine?.terminal).toEqual({
      state: "done",
      status: "completed",
      reason: undefined,
    });
  });

  test("each parent pass that starts parked carries the binding park nudge", async () => {
    const { runner } = createTurnRunner();
    const definition = parkDefinition();
    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "await_approval" } },
      { type: "none" },
    );
    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;
    await runner.turn({ type: "prompt", message: "Still waiting.", behavior: "follow_up" });

    expect(runner.workerInputs.at(-1)?.prompt).toContain(
      'The state machine is parked at "await_approval".',
    );
    expect(runner.workerInputs.at(-1)?.prompt).toContain(
      "otherwise\nyou may end your turn and the machine stays parked",
    );
  });
});
