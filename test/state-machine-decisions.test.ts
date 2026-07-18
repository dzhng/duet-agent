import { describe, expect, test } from "bun:test";
import {
  planDecision,
  planWake,
  recordSettled,
  startSession,
} from "../src/turn-runner/state-machine-decisions.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

describe("StateMachineDecisions", () => {
  test("recordSettled normalizes script output and records completion", () => {
    const definition: StateMachineDefinition = {
      name: "script",
      prompt: "Run.",
      states: [
        { kind: "script", name: "emit", command: "printf ok" },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const planned = planDecision(
      startSession({ prompt: "Run.", definition, currentState: "emit" }),
      { state: "emit" },
    );

    const settled = recordSettled(planned.session, "emit", "script", {
      type: "completed",
      output: { stdout: " ok\n", stderr: "", exitCode: 0 },
    });

    expect(settled.outcome).toEqual({
      type: "state_completed",
      stateName: "emit",
      output: { stdout: "ok", stderr: "", exitCode: 0, parsed: { result: "ok" } },
    });
    expect(settled.session.history.at(-1)).toMatchObject({
      type: "state_completed",
      state: "emit",
      output: { stdout: "ok", parsed: { result: "ok" } },
    });
  });

  test("recordSettled re-arms a failed poll and planWake returns the same shell policy", () => {
    const definition: StateMachineDefinition = {
      name: "poll",
      prompt: "Poll.",
      states: [
        { kind: "poll", name: "check", command: "exit 1", intervalMs: 60_000 },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const planned = planDecision(
      startSession({ prompt: "Poll.", definition, currentState: "check" }),
      { state: "check" },
    );
    const before = Date.now();

    const settled = recordSettled(
      planned.session,
      "check",
      "poll",
      { type: "failed", error: "Command exited with code 1." },
      undefined,
    );

    expect(settled.outcome.type).toBe("sleep");
    if (settled.outcome.type !== "sleep") return;
    expect(settled.outcome.wakeAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(planWake(settled.session)?.work).toEqual({
      run: {
        shell: { command: "exit 1", cwd: undefined, successCodes: undefined },
        stateName: "check",
        pollPolicy: { intervalMs: 60_000 },
      },
    });
  });

  test("recordSettled enriches an interruption already recorded by the shim", () => {
    const definition: StateMachineDefinition = {
      name: "interrupt",
      prompt: "Run.",
      states: [
        { kind: "agent", name: "work", prompt: "Work." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const planned = planDecision(
      startSession({ prompt: "Run.", definition, currentState: "work" }),
      { state: "work" },
    );
    const first = recordSettled(planned.session, "work", "agent", {
      type: "interrupted",
      reason: "Replaced",
    });

    const final = recordSettled(
      first.session,
      "work",
      "agent",
      { type: "interrupted", reason: "Replaced" },
      { assistantText: "partial" },
    );

    expect(
      final.session.history.filter((event) => event.type === "state_interrupted"),
    ).toHaveLength(1);
    expect(final.session.history.at(-1)).toMatchObject({
      type: "state_interrupted",
      state: "work",
      reason: "Replaced",
      output: { assistantText: "partial" },
    });
  });
});
