import { describe, expect, test } from "bun:test";
import {
  createHarness,
  createOutreachStateMachine,
  createStateMachineRun,
} from "./helpers/harness-protocol.js";

describe("Harness protocol scenarios", () => {
  test("runs a simple auto-classified prompt in agent mode", async () => {
    const { harness, events } = createHarness();

    const terminal = await harness.turn({
      type: "start",
      prompt: "Summarize this file.",
      mode: "auto",
    });

    expect(events[0]).toMatchObject({
      type: "run_started",
      run: { agent: { status: "running" } },
    });
    expect(events.some((event) => event.type === "state_machine")).toBe(false);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      run: { agent: { status: "completed" } },
    });
    expect(terminal.run.stateMachine).toBeUndefined();
  });

  test("auto-selects a state machine for a long-running lifecycle and streams UI state", async () => {
    const { harness, events } = createHarness();

    const terminal = await harness.turn({
      type: "start",
      prompt: "Prospect Ada until she books a meeting.",
      mode: "auto",
    });

    expect(events[0]).toMatchObject({
      type: "run_started",
      run: {
        agent: { status: "running" },
        stateMachine: { status: "running", currentState: "research_prospect" },
      },
    });
    expect(events).toContainEqual({
      type: "state_machine",
      status: "running",
      currentState: "research_prospect",
    });
    expect(events.some((event) => event.type === "step")).toBe(true);
    expect(events.some((event) => event.type === "todos")).toBe(true);
    expect(terminal.run.stateMachine).toBeDefined();
  });

  test("uses a steering prompt to update and continue an active state-machine run", async () => {
    const { harness, events } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "I've already received this email: yes, happy to meet next week.",
      behavior: "steer",
    });

    expect(events).toContainEqual({
      type: "state_machine",
      status: "running",
      currentState: "classify_reply",
    });
    expect(terminal.run.agent.messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(terminal.run.stateMachine?.currentState).toBe("classify_reply");
  });

  test("sleeps between poll attempts while waiting for an external email response", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("poll_email_reply");

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Continue polling.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      run: {
        agent: { status: "waiting" },
        stateMachine: { status: "waiting", currentState: "poll_email_reply" },
      },
    });
    expect(terminal.type === "sleep" ? terminal.wakeAt : 0).toBeGreaterThan(Date.now());
  });

  test("interrupts a running turn and resolves it with the current run", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("send_email");

    const turn = harness.turn({
      type: "prompt",
      run,
      message: "Send the email now.",
      behavior: "steer",
    });
    harness.interrupt({ type: "interrupt", run });
    const terminal = await turn;

    expect(terminal).toMatchObject({
      type: "interrupted",
      run: {
        agent: { status: "cancelled" },
        stateMachine: { status: "cancelled", currentState: "send_email" },
      },
    });
  });

  test("runs an explicit state machine when the prompt matches the definition", async () => {
    const { harness, events } = createHarness();
    const definition = createOutreachStateMachine();

    const terminal = await harness.turn({
      type: "start",
      prompt: "Prospect Ada until she books a meeting.",
      mode: definition,
    });

    expect(events[0]).toMatchObject({
      type: "run_started",
      run: {
        agent: { status: "running" },
        stateMachine: { status: "running", currentState: "research_prospect" },
      },
    });
    expect(terminal.run.stateMachine).toBeDefined();
  });

  test("answers normally when an explicit state machine does not fit the prompt", async () => {
    const { harness, events } = createHarness();
    const definition = createOutreachStateMachine();

    const terminal = await harness.turn({
      type: "start",
      prompt: "What is the capital of France?",
      mode: definition,
    });

    expect(events[0]).toMatchObject({
      type: "run_started",
      run: { agent: { status: "running" } },
    });
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
    });
    expect(terminal.run.stateMachine).toBeUndefined();
  });
});
