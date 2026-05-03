import { describe, expect, test } from "bun:test";
import {
  createHarness,
  createOutreachStateMachine,
  createStateMachineRun,
} from "./helpers/harness-protocol.js";
import { judge } from "./helpers/judge.js";

describe("Harness protocol scenarios", () => {
  test("runs a simple auto-classified prompt in agent mode", async () => {
    const { harness, events } = createHarness();

    const terminal = await harness.turn({
      type: "start",
      prompt: "Summarize this file.",
      mode: "auto",
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "run_started",
      run: { status: "running", agent: { status: "running" } },
    });
    expect(events.some((event) => event.type === "state_machine")).toBe(false);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      run: { status: "completed", agent: { status: "completed" } },
    });
    expect(terminal.run.stateMachine).toBeUndefined();
  });

  test("auto-selects a valid state machine for a long-running lifecycle and streams UI state", async () => {
    const { harness, events } = createHarness();
    const prompt = "Prospect Ada until she books a meeting.";

    const terminal = await harness.turn({
      type: "start",
      prompt,
      mode: "auto",
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "run_started",
      run: {
        status: "running",
        agent: { status: "running" },
        stateMachine: {},
      },
    });
    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");
    expect(events.some((event) => event.type === "step")).toBe(true);
    expect(events.some((event) => event.type === "todos")).toBe(true);
    expect(terminal.run.stateMachine).toBeDefined();

    const judgment = await judge({
      prompt:
        "The input should show a coherent state-machine run for the user's long-running outreach task. Do not require exact state names.",
      value: { prompt, run: terminal.run, events },
    });
    expect(judgment.valid).toBe(true);
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

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");
    expect(terminal.run.agent.messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(terminal.run.stateMachine?.currentState).not.toBe("waiting_for_reply");
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
        status: "sleeping",
        agent: { status: "waiting" },
        stateMachine: { currentState: "poll_email_reply" },
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
        status: "interrupted",
        agent: { status: "cancelled" },
        stateMachine: { currentState: "send_email" },
      },
    });
  });

  test("runs an explicit state machine when the prompt matches the definition", async () => {
    const { harness, events } = createHarness();
    const definition = createOutreachStateMachine();
    const prompt = "Prospect Ada until she books a meeting.";

    const terminal = await harness.turn({
      type: "start",
      prompt,
      mode: definition,
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "run_started",
      run: {
        status: "running",
        agent: { status: "running" },
        stateMachine: {},
      },
    });
    expect(terminal.run.stateMachine).toBeDefined();

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");

    const judgment = await judge({
      prompt:
        "The input should show that the explicit state-machine definition was a good fit for the user's outreach task and produced a coherent state-machine run. Do not require exact state names.",
      value: { prompt, run: terminal.run, events, definition },
    });
    expect(judgment.valid).toBe(true);
  });

  test("answers normally when an explicit state machine does not fit the prompt", async () => {
    const { harness, events } = createHarness();
    const definition = createOutreachStateMachine();

    const terminal = await harness.turn({
      type: "start",
      prompt: "What is the capital of France?",
      mode: definition,
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "run_started",
      run: { status: "running", agent: { status: "running" } },
    });
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
    });
    expect(terminal.run.stateMachine).toBeUndefined();
  });
});
