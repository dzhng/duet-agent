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

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "run_started",
      run: { status: "running", mode: "auto", agent: { status: "running" } },
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
    const definition = createOutreachStateMachine();
    harness.controlResults.push({
      type: "create_state_machine_definition",
      definition,
      firstState: "research_prospect",
    });

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
        mode: "auto",
        agent: { status: "running" },
      },
    });
    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");
    expect(terminal.run.stateMachine).toBeDefined();
    expect(terminal.run.mode).toBe("auto");
    expect(terminal.run.stateMachine?.definition).toBeDefined();
    expect(
      terminal.run.stateMachine?.history.some((event) => event.type === "state_completed"),
    ).toBe(true);

    expect(harness.workerInputs[0]?.tools.map((tool) => tool.name)).toContain(
      "create_state_machine_definition",
    );
  });

  test("uses a steering prompt to update and continue an active state-machine run", async () => {
    const { harness, events } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "classify_reply" },
    });

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
      role: "assistant",
    });
    expect(terminal.run.stateMachine?.currentState).not.toBe("waiting_for_reply");
  });

  test("sleeps between poll attempts while waiting for an external email response", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("poll_email_reply");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "poll_email_reply" },
    });

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
        mode: "auto",
        agent: { status: "completed" },
        stateMachine: { currentState: "poll_email_reply" },
      },
    });
    expect(terminal.type === "sleep" ? terminal.wakeAt : 0).toBeGreaterThan(Date.now());
  });

  test("interrupts a running turn and resolves it with the current run", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("send_email");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "fail", reason: "Interrupted" },
    });

    const turn = harness.turn({
      type: "prompt",
      run,
      message: "Send the email now.",
      behavior: "steer",
    });
    const terminal = await turn;

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      run: {
        status: "failed",
        mode: "auto",
        agent: { status: "completed" },
        stateMachine: { currentState: "send_email" },
      },
    });
  });

  test("runs an explicit state machine when the prompt matches the definition", async () => {
    const { harness, events } = createHarness();
    const definition = createOutreachStateMachine();
    const prompt = "Prospect Ada until she books a meeting.";
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

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
        mode: definition,
        agent: { status: "running" },
      },
    });
    expect(terminal.run.stateMachine).toBeDefined();
    expect(terminal.run.mode).toBe(definition);
    expect(terminal.run.stateMachine?.definition).toBe(definition);

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");

    expect(harness.workerInputs[0]?.tools.map((tool) => tool.name)).not.toContain(
      "create_state_machine_definition",
    );
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
      run: { status: "running", mode: definition, agent: { status: "running" } },
    });
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
    });
    expect(terminal.run.stateMachine).toBeUndefined();
  });

  test("uses transition overrides for one state attempt without mutating the definition", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("research_prospect");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: {
        kind: "run_state",
        state: "research_prospect",
        override: { kind: "agent", state: { prompt: "Research Grace Hopper." } },
      },
    });

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Focus on Grace.",
      behavior: "steer",
    });

    const started = terminal.run.stateMachine?.history.find(
      (event) => event.type === "state_started",
    );
    expect(started?.type === "state_started" ? started.effectiveState : undefined).toMatchObject({
      prompt: "Research Grace Hopper.",
    });
    expect(terminal.run.stateMachine?.definition.states[0]).toMatchObject({
      prompt: "Research the prospect and company.",
    });
  });

  test("bubbles an agent state's ask terminal status to the parent harness", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("research_prospect");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });
    let calls = 0;
    harness.worker = async (input, next) => {
      calls += 1;
      if (calls === 2) {
        return {
          control: { type: "none" },
          terminal: {
            type: "ask",
            questions: [{ question: "Need detail?", options: [{ label: "Yes" }] }],
            run: { ...input.run, status: "waiting_for_human" },
          },
        };
      }
      return next();
    };

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Continue.",
      behavior: "steer",
    });

    expect(terminal).toMatchObject({ type: "ask", run: { status: "waiting_for_human" } });
  });
});
