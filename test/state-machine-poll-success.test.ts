import { describe, expect, test } from "bun:test";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

/**
 * Regression coverage for the poll-state success contract.
 *
 * The semantics are: a poll attempt is considered successful (and the
 * state completes) iff the script exits with a code in `successCodes`
 * (default `[0]`). Stdout is captured and surfaced as the state output
 * — and parsed as JSON for convenience — but the parse result must
 * never influence whether the poll completes. Prior to this contract
 * a poll attempt that exited 0 with non-JSON or empty stdout was
 * silently re-armed as a sleep, which made plain-text dispatcher
 * scripts hang forever.
 */
describe("poll-state success contract", () => {
  test("exit 0 with empty stdout completes the poll", async () => {
    const definition: StateMachineDefinition = {
      name: "empty_stdout",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "check",
          intervalMs: 60_000,
          command: "true",
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Poll.", definition, currentState: "check" });

    const result = await controller.runDecision({ kind: "run_state", state: "check" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect(result.stateName).toBe("check");
      expect(result.output).toMatchObject({ exitCode: 0, parsed: {} });
    }
  });

  test("exit 0 with plain-text stdout completes the poll and surfaces the text", async () => {
    const definition: StateMachineDefinition = {
      name: "plain_text",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "check",
          intervalMs: 60_000,
          command: "printf check-duet-inbox",
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Poll.", definition, currentState: "check" });

    const result = await controller.runDecision({ kind: "run_state", state: "check" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect(result.output).toMatchObject({
        exitCode: 0,
        stdout: "check-duet-inbox",
        parsed: {},
      });
    }
  });

  test("exit 0 with JSON stdout still completes and exposes the parsed payload", async () => {
    const definition: StateMachineDefinition = {
      name: "json_stdout",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "check",
          intervalMs: 60_000,
          command: 'printf \'{"agent":"check-duet-inbox"}\'',
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Poll.", definition, currentState: "check" });

    const result = await controller.runDecision({ kind: "run_state", state: "check" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect(result.output).toMatchObject({
        exitCode: 0,
        parsed: { agent: "check-duet-inbox" },
      });
    }
  });

  test("non-success exit sleeps and re-arms the poll", async () => {
    const definition: StateMachineDefinition = {
      name: "no_result",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "check",
          intervalMs: 60_000,
          command: "exit 1",
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Poll.", definition, currentState: "check" });

    const before = Date.now();
    const result = await controller.runDecision({ kind: "run_state", state: "check" });
    expect(result.type).toBe("sleep");
    if (result.type === "sleep") {
      expect(result.wakeAt).toBeGreaterThanOrEqual(before + 60_000 - 5);
    }
  });

  test("custom successCodes treat the matching exit code as a result and others as keep-polling", async () => {
    const baseDefinition = (cmd: string): StateMachineDefinition => ({
      name: "custom_codes",
      prompt: "Poll.",
      states: [
        {
          kind: "poll",
          name: "check",
          intervalMs: 60_000,
          successCodes: [7],
          command: cmd,
        },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    });

    {
      const controller = createController();
      controller.startSession({
        prompt: "Poll.",
        definition: baseDefinition("exit 7"),
        currentState: "check",
      });
      const result = await controller.runDecision({ kind: "run_state", state: "check" });
      expect(result.type).toBe("state_completed");
    }

    {
      const controller = createController();
      controller.startSession({
        prompt: "Poll.",
        definition: baseDefinition("exit 0"),
        currentState: "check",
      });
      const result = await controller.runDecision({ kind: "run_state", state: "check" });
      expect(result.type).toBe("sleep");
    }
  });
});

function createController(): StateMachineController {
  return new StateMachineController({
    cwd: process.cwd(),
    createStateAgent: () => {
      throw new Error("Agent state should not be invoked in poll-success tests.");
    },
  });
}
