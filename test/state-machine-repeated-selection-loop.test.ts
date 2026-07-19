import { describe, expect, test } from "bun:test";
import {
  repeatedSelectionLoopCount,
  repeatedStateSelectionStreak,
  REPEATED_SELECTION_LOOP_THRESHOLD,
  REPEATED_SELECTION_LOOP_WINDOW_MS,
} from "../src/turn-runner/state-machine-decisions.js";
import type {
  StateMachineDefinition,
  StateMachineSession,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";

/**
 * Coverage for the no-progress re-selection guard.
 *
 * The idle-loop footgun: the orchestrator re-selects the same "holding" state
 * over and over to "keep waiting", but selecting a state runs it immediately
 * rather than suspending the machine — so the relay hot-loops without ever
 * waiting on anything. `repeatedStateSelectionStreak` measures the back-to-back
 * run of selections of one state (with no different state in between) plus the
 * span it covers, so the turn runner can inject a loop warning only when the
 * streak is both long and tightly clustered in time. A streak interrupted by a
 * different state, or spread over a long span, must not read as a hot loop.
 */

function definition(): StateMachineDefinition {
  return {
    name: "gate",
    prompt: "Hold for the user.",
    states: [
      { kind: "agent", name: "hold", prompt: "Hold." },
      { kind: "agent", name: "work", prompt: "Do work." },
      { kind: "park", name: "parked", when: "Wait for the user." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function session(history: StateMachineSessionEvent[]): StateMachineSession {
  return {
    definition: definition(),
    prompt: "Hold for the user.",
    currentState: "hold",
    history,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** One full select→run→complete cycle for `state`, at the given timestamp. */
function selectionCycle(state: string, timestamp: number): StateMachineSessionEvent[] {
  return [
    { type: "runner_decided", timestamp, decision: { state } },
    { type: "state_started", timestamp, state },
    { type: "state_completed", timestamp, state },
  ];
}

describe("repeatedStateSelectionStreak", () => {
  test("counts back-to-back selections of the same state", () => {
    const history = [
      ...selectionCycle("hold", 1),
      ...selectionCycle("hold", 2),
      ...selectionCycle("hold", 3),
    ];
    expect(repeatedStateSelectionStreak(session(history), "hold").count).toBe(3);
  });

  test("a different state's run resets the streak", () => {
    const history = [
      ...selectionCycle("hold", 1),
      ...selectionCycle("hold", 2),
      ...selectionCycle("work", 3),
      ...selectionCycle("hold", 4),
    ];
    expect(repeatedStateSelectionStreak(session(history), "hold").count).toBe(1);
  });

  test("no prior selections reports zero", () => {
    expect(repeatedStateSelectionStreak(session([]), "hold").count).toBe(0);
  });

  test("reports the span between the streak's first and latest selection", () => {
    const start = 1_000;
    const end = start + 4 * 60 * 1000;
    const history = [
      ...selectionCycle("hold", start),
      ...selectionCycle("hold", start + 60 * 1000),
      ...selectionCycle("hold", end),
    ];
    expect(repeatedStateSelectionStreak(session(history), "hold").spanMs).toBe(end - start);
  });
});

describe("repeatedSelectionLoopCount (trip policy)", () => {
  test("a tight, threshold-length streak trips the policy and reports the count", () => {
    const history: StateMachineSessionEvent[] = [];
    for (let i = 0; i < REPEATED_SELECTION_LOOP_THRESHOLD; i++) {
      history.push(...selectionCycle("hold", i * 1000));
    }
    expect(repeatedSelectionLoopCount(session(history), "hold")).toBe(
      REPEATED_SELECTION_LOOP_THRESHOLD,
    );
  });

  test("a streak below threshold does not trip the policy", () => {
    const history: StateMachineSessionEvent[] = [];
    for (let i = 0; i < REPEATED_SELECTION_LOOP_THRESHOLD - 1; i++) {
      history.push(...selectionCycle("hold", i * 1000));
    }
    expect(repeatedSelectionLoopCount(session(history), "hold")).toBeUndefined();
  });

  test("a threshold-length streak spread beyond the window does not trip the policy", () => {
    const step = REPEATED_SELECTION_LOOP_WINDOW_MS; // each selection a full window apart
    const history: StateMachineSessionEvent[] = [];
    for (let i = 0; i < REPEATED_SELECTION_LOOP_THRESHOLD; i++) {
      history.push(...selectionCycle("hold", i * step));
    }
    expect(repeatedSelectionLoopCount(session(history), "hold")).toBeUndefined();
  });

  test("re-selecting the same park remains legal at the loop threshold", () => {
    const history: StateMachineSessionEvent[] = [];
    for (let i = 0; i < REPEATED_SELECTION_LOOP_THRESHOLD; i++) {
      history.push(
        { type: "runner_decided", timestamp: i * 1000, decision: { state: "parked" } },
        { type: "state_started", timestamp: i * 1000, state: "parked" },
      );
    }
    const parked = { ...session(history), currentState: "parked" };
    expect(repeatedStateSelectionStreak(parked, "parked").count).toBe(
      REPEATED_SELECTION_LOOP_THRESHOLD,
    );
    expect(repeatedSelectionLoopCount(parked, "parked")).toBeUndefined();
  });
});
