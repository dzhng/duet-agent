import { describe, expect, test } from "bun:test";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import {
  consecutivePollGateSuccesses,
  MISCONFIGURED_POLL_GATE_THRESHOLD,
} from "../src/turn-runner/state-machine-session.js";
import type {
  StateMachineDefinition,
  StateMachineSession,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";

/**
 * Coverage for the misconfigured poll-gate heuristic.
 *
 * A poll whose command exits success on every tick (the classic
 * `echo waiting for review` human-wait footgun) is read as "condition met"
 * and handed back to the orchestrator, which re-selects the same poll and
 * hot-loops without ever honoring intervalMs. The runner detects the
 * signature — N back-to-back successes of the same poll with no state change
 * in between — and fails the relay with an actionable message instead of
 * spinning. Polls that genuinely sleep, or that transition to a different
 * state, must never trip the guard.
 */

function pollDefinition(command: string): StateMachineDefinition {
  return {
    name: "gate",
    prompt: "Poll.",
    states: [
      { kind: "poll", name: "check", intervalMs: 60_000, command },
      // A script state used to simulate the relay actually moving on between
      // poll successes (the legitimate "do work each time" pattern).
      { kind: "script", name: "work", command: "true" },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function createController(): StateMachineController {
  return new StateMachineController({
    cwd: process.cwd(),
    createStateAgent: () => {
      throw new Error("Agent state should not be invoked in poll-gate tests.");
    },
  });
}

describe("consecutivePollGateSuccesses", () => {
  function session(history: StateMachineSessionEvent[]): StateMachineSession {
    return {
      definition: pollDefinition("true"),
      prompt: "Poll.",
      currentState: "check",
      history,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  test("counts back-to-back completions of the same poll", () => {
    const s = session([
      { type: "state_completed", timestamp: 1, state: "check" },
      { type: "runner_decided", timestamp: 2, decision: { state: "check" } },
      { type: "state_started", timestamp: 3, state: "check" },
      { type: "state_completed", timestamp: 4, state: "check" },
    ]);
    expect(consecutivePollGateSuccesses(s, "check")).toBe(2);
  });

  test("a different state's activity breaks the streak", () => {
    const s = session([
      { type: "state_completed", timestamp: 1, state: "check" },
      { type: "state_started", timestamp: 2, state: "work" },
      { type: "state_completed", timestamp: 3, state: "work" },
      { type: "state_started", timestamp: 4, state: "check" },
      { type: "state_completed", timestamp: 5, state: "check" },
    ]);
    expect(consecutivePollGateSuccesses(s, "check")).toBe(1);
  });

  test("no prior completions reports zero", () => {
    expect(consecutivePollGateSuccesses(session([]), "check")).toBe(0);
  });
});

describe("misconfigured poll-gate guard", () => {
  test("an always-succeeds poll fails on the threshold-th consecutive success", async () => {
    const controller = createController();
    controller.startSession({
      prompt: "Poll.",
      definition: pollDefinition("true"),
      currentState: "check",
    });

    // The first THRESHOLD-1 successes are handed back normally so the
    // orchestrator stays in control of legitimately fast work.
    for (let i = 0; i < MISCONFIGURED_POLL_GATE_THRESHOLD - 1; i++) {
      const result = await controller.runDecision({ state: "check" });
      expect(result.type).toBe("state_completed");
    }

    const tripped = await controller.runDecision({ state: "check" });
    expect(tripped.type).toBe("terminal");
    if (tripped.type === "terminal") {
      // The misconfigured-gate trip is a runtime failure, so it surfaces as an
      // `error` terminal (which fails the turn), not a deliberate `failed`.
      expect(tripped.status).toBe("error");
      expect(tripped.error).toContain("no state change");
      expect(tripped.error).toContain("agent state");
    }
  });

  test("a non-success poll sleeps and never trips the guard", async () => {
    const controller = createController();
    controller.startSession({
      prompt: "Poll.",
      definition: pollDefinition("exit 1"),
      currentState: "check",
    });

    for (let i = 0; i < MISCONFIGURED_POLL_GATE_THRESHOLD + 2; i++) {
      const result = await controller.runDecision({ state: "check" });
      expect(result.type).toBe("sleep");
    }
  });

  test("transitioning to another state between successes resets the streak", async () => {
    const controller = createController();
    controller.startSession({
      prompt: "Poll.",
      definition: pollDefinition("true"),
      currentState: "check",
    });

    // Drive many cycles but always run real work between poll successes —
    // the legitimate "poll, act, poll again" pattern must keep flowing.
    for (let i = 0; i < MISCONFIGURED_POLL_GATE_THRESHOLD + 3; i++) {
      const poll = await controller.runDecision({ state: "check" });
      expect(poll.type).toBe("state_completed");
      const work = await controller.runDecision({ state: "work" });
      expect(work.type).toBe("state_completed");
    }
  });
});
