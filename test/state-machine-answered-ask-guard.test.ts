import { describe, expect, test } from "bun:test";
import { createTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";
import { isAwaitingUserAnswer } from "../src/turn-runner/state-machine-session.js";
import type {
  StateMachineDefinition,
  StateMachineSession,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";

/**
 * Guard for the answered-ask transition the parent owes the machine.
 *
 * When an agent state calls ask_user_question the machine suspends at that
 * state with no terminal recorded. The user's answer arrives as an ordinary
 * parent prompt, so if the parent replies in text without calling
 * select_state_machine_state the machine would silently stall at the asking
 * state. The turn runner detects "answered an ask, owed a transition, emitted
 * none" and enforces the transition under a bounded retry budget, failing the
 * relay with an `error` terminal when the parent never advances — symmetric
 * with the post-state-completion guard.
 */

function askDefinition(): StateMachineDefinition {
  return {
    name: "answered_ask_guard",
    prompt: "Validate that an answered ask forces a state transition.",
    states: [
      { kind: "agent", name: "ask_step", prompt: "Ask the user which path to take." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function session(history: StateMachineSessionEvent[]): StateMachineSession {
  return {
    definition: askDefinition(),
    prompt: "Ask.",
    currentState: "ask_step",
    history,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("isAwaitingUserAnswer", () => {
  test("true when the latest lifecycle event is an unanswered ask", () => {
    expect(
      isAwaitingUserAnswer(
        session([
          { type: "runner_decided", timestamp: 1, decision: { state: "ask_step" } },
          { type: "state_started", timestamp: 2, state: "ask_step" },
          { type: "state_asked_user", timestamp: 3, state: "ask_step", questions: [] },
        ]),
      ),
    ).toBe(true);
  });

  test("ignores pure-noise events recorded after the ask", () => {
    expect(
      isAwaitingUserAnswer(
        session([
          { type: "state_started", timestamp: 1, state: "ask_step" },
          { type: "state_asked_user", timestamp: 2, state: "ask_step", questions: [] },
          {
            type: "state_definition_updated",
            timestamp: 3,
            state: "ask_step",
            updatedState: { kind: "agent", name: "ask_step", prompt: "Ask." },
          },
        ]),
      ),
    ).toBe(true);
  });

  test("false once a transition starts the next state", () => {
    expect(
      isAwaitingUserAnswer(
        session([
          { type: "state_asked_user", timestamp: 1, state: "ask_step", questions: [] },
          { type: "runner_decided", timestamp: 2, decision: { state: "done" } },
          { type: "state_started", timestamp: 3, state: "done" },
        ]),
      ),
    ).toBe(false);
  });

  test("false when a terminal has been recorded", () => {
    expect(
      isAwaitingUserAnswer({
        ...session([{ type: "state_asked_user", timestamp: 1, state: "ask_step", questions: [] }]),
        terminal: { state: "ask_step", status: "error", reason: "boom" },
      }),
    ).toBe(false);
  });
});

describe("answered-ask transition guard", () => {
  test("fails the relay when the parent answers but never transitions", async () => {
    const { runner } = createTurnRunner();
    const definition = askDefinition();

    // 1: parent selects the asking state. 2: that agent state asks the user.
    // The answer turn and every enforcement retry then default to `none`
    // (the parent never calls select_state_machine_state), so the guard must
    // exhaust its budget and record an error terminal.
    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "ask_step" } },
      {
        type: "ask_user_question",
        questions: [{ question: "Which path?", options: [{ label: "left" }, { label: "right" }] }],
      },
    );

    const asked = await (await startTurn(runner, { mode: definition, prompt: "Begin." })).turn;
    expect(asked.type).toBe("ask");

    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which path?", options: [{ label: "left" }, { label: "right" }] }],
      answers: { "Which path?": ["left"] },
      behavior: "follow_up",
    });

    expect(terminal.type).toBe("complete");
    expect(terminal.type === "complete" ? terminal.status : undefined).toBe("failed");
    expect(terminal.type === "complete" ? terminal.error : undefined).toContain(
      "did not call select_state_machine_state",
    );
    expect(terminal.state.stateMachine?.terminal?.status).toBe("error");
  });

  test("advances normally when the parent transitions on the answer turn", async () => {
    const { runner } = createTurnRunner();
    const definition = askDefinition();

    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "ask_step" } },
      {
        type: "ask_user_question",
        questions: [{ question: "Which path?", options: [{ label: "left" }, { label: "right" }] }],
      },
      // The answer turn drives the machine to its terminal — no guard trip.
      { type: "select_state_machine_state", decision: { state: "done" } },
    );

    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;

    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which path?", options: [{ label: "left" }, { label: "right" }] }],
      answers: { "Which path?": ["right"] },
      behavior: "follow_up",
    });

    expect(terminal.type).toBe("complete");
    expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");
    expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
  });
});

/**
 * The guard fires ONLY when an answered ask produces no control action. Any
 * real control action — a clarifying re-ask, or a replaceActive create that
 * swaps the machine — is a valid parent response and must pass through
 * untouched. These pin that boundary so a future change to
 * `isAwaitingUserAnswer` (or the guard call site) can't start force-failing
 * legitimate answer turns.
 */
describe("answered-ask guard leaves legitimate control actions alone", () => {
  test("a clarifying re-ask on the answer turn is allowed, not force-failed", async () => {
    const { runner } = createTurnRunner();
    const definition = askDefinition();
    const followUp = [
      { question: "Left or right?", options: [{ label: "left" }, { label: "right" }] },
    ];

    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "ask_step" } },
      {
        type: "ask_user_question",
        questions: [{ question: "Which path?", options: [{ label: "a" }, { label: "b" }] }],
      },
      // Answer turn: the parent asks a follow-up question instead of
      // transitioning. That is a valid control action, so the machine
      // re-suspends at another ask rather than tripping the guard.
      { type: "ask_user_question", questions: followUp },
    );

    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;

    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which path?", options: [{ label: "a" }, { label: "b" }] }],
      answers: { "Which path?": ["a"] },
      behavior: "follow_up",
    });

    expect(terminal.type).toBe("ask");
    expect(terminal.type === "ask" ? terminal.questions : undefined).toEqual(followUp);
    expect(terminal.state.stateMachine?.terminal).toBeUndefined();
  });

  test("a replaceActive create on the answer turn swaps the machine, not force-failed", async () => {
    const { runner } = createTurnRunner();
    const definition = askDefinition();
    const replacement: StateMachineDefinition = {
      name: "replacement_machine",
      prompt: "Installed in place of the asking machine.",
      states: [{ kind: "terminal", name: "replaced_done", status: "completed" }],
    };

    runner.controlResults.push(
      { type: "select_state_machine_state", decision: { state: "ask_step" } },
      {
        type: "ask_user_question",
        questions: [{ question: "Which path?", options: [{ label: "a" }, { label: "b" }] }],
      },
      // Answer turn: the parent replaces the suspended machine. The create
      // supersedes the asking session and runs the new machine's first
      // state (a terminal), so the answer turn completes via the new
      // machine instead of the guard's error path.
      {
        type: "create_state_machine_definition",
        definition: replacement,
        firstState: "replaced_done",
      },
    );

    await (
      await startTurn(runner, { mode: definition, prompt: "Begin." })
    ).turn;

    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which path?", options: [{ label: "a" }, { label: "b" }] }],
      answers: { "Which path?": ["a"] },
      behavior: "follow_up",
    });

    expect(terminal.type).toBe("complete");
    expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");
    expect(terminal.state.stateMachine?.definition.name).toBe("replacement_machine");
    expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
    expect(terminal.state.stateMachine?.terminal?.state).toBe("replaced_done");
  });
});
