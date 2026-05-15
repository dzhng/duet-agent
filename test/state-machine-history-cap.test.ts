import { describe, expect, test } from "bun:test";
import {
  STATE_MACHINE_HISTORY_LIMIT,
  createStateMachineSession,
  recordStateCompleted,
  recordStateStarted,
} from "../src/turn-runner/state-machine-session.js";
import type { StateMachineDefinition, StateMachineState } from "../src/types/state-machine.js";

const pollState: StateMachineState = {
  kind: "poll",
  name: "watch",
  intervalMs: 60_000,
  timeoutMs: 60 * 60 * 1000,
  command: "exit 0",
};

const definition: StateMachineDefinition = {
  name: "history-cap",
  prompt: "exercise history trimming",
  states: [pollState],
};

describe("state machine history cap", () => {
  test("history is capped at STATE_MACHINE_HISTORY_LIMIT", () => {
    let session = createStateMachineSession("prompt", definition, "watch");
    // Force a couple-hundred completions of the same state to exceed the cap.
    for (let i = 0; i < 250; i++) {
      session = recordStateStarted(session, pollState);
      session = recordStateCompleted(session, "watch", { tick: i });
    }
    expect(session.history.length).toBe(STATE_MACHINE_HISTORY_LIMIT);
    // The newest event survives.
    const last = session.history.at(-1);
    expect(last?.type).toBe("state_completed");
    expect(last?.type === "state_completed" ? (last.output as { tick: number }).tick : -1).toBe(
      249,
    );
  });

  test("recordStateStarted stamps startedAt on progress so elapsed survives trimming", () => {
    let session = createStateMachineSession("prompt", definition, "watch");
    const before = Date.now();
    session = recordStateStarted(session, pollState);
    const startedAt = session.progress?.states.watch?.startedAt;
    expect(startedAt).toBeDefined();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    // Trim history past the cap; progress.startedAt is independent of history.
    for (let i = 0; i < STATE_MACHINE_HISTORY_LIMIT + 5; i++) {
      session = recordStateCompleted(session, "watch", { tick: i });
    }
    expect(session.progress?.states.watch?.startedAt).toBe(startedAt);
  });
});
