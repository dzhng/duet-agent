import { describe, expect, test } from "bun:test";
import assert from "node:assert";
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

  test("answers unrelated prompts during an active state-machine run without changing state", async () => {
    const { harness, events } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "What is the capital of France?",
      behavior: "follow_up",
    });

    expect(events.some((event) => event.type === "state_machine")).toBe(false);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
      run: {
        status: "completed",
        stateMachine: { currentState: "waiting_for_reply" },
      },
    });
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

  test("wakes a sleeping poll run for one polling attempt", async () => {
    const { harness } = createHarness();
    const run = { ...createStateMachineRun("poll_email_reply"), status: "sleeping" as const };

    const terminal = await harness.turn({
      type: "wake",
      run,
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      run: {
        status: "sleeping",
        stateMachine: { currentState: "poll_email_reply" },
      },
    });
  });

  test("wake is a no-op when the run is not sleeping on a poll", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");

    const terminal = await harness.turn({
      type: "wake",
      run,
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: "Nothing to wake.",
      run,
    });
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
    expect(harness.workerInputs[0]?.systemPrompt).toContain("Explicit state-machine definition");
    expect(harness.workerInputs[0]?.systemPrompt).toContain('"name": "conference_outreach"');
    expect(harness.workerInputs[0]?.systemPrompt).toContain('"name": "research_prospect"');
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

  test("reports valid states when the runner selects an invalid state", async () => {
    const { harness } = createHarness();
    const definition = createOutreachStateMachine();
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "invented_state" },
    });

    const terminal = await harness.turn({
      type: "start",
      prompt: "Prospect Ada until she books a meeting.",
      mode: definition,
    });

    if (terminal.type !== "complete") {
      throw new Error("Expected complete event");
    }
    expect(terminal.status).toBe("failed");
    const error = terminal.error ?? "";
    expect(error.includes("Unknown state: invented_state")).toBe(true);
    expect(error.includes("research_prospect")).toBe(true);
    expect(error.includes("send_email")).toBe(true);
    expect(error.includes("meeting_scheduled")).toBe(true);
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

  test("asks the parent runner for the next state immediately after a state completes", async () => {
    const { harness, events } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");
    harness.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: { kind: "run_state", state: "research_prospect" },
      },
      { type: "none" },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(harness.workerInputs).toHaveLength(3);
    expect(harness.workerInputs[2]?.prompt).toContain('The state "research_prospect" finished.');
    expect(events.filter((event) => event.type === "state_machine")).toHaveLength(2);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      run: {
        status: "completed",
        stateMachine: {
          currentState: "meeting_scheduled",
          terminal: { state: "meeting_scheduled", status: "completed" },
        },
      },
    });
  });

  test("retries when the parent runner does not choose the next state after completion", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");
    harness.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(harness.workerInputs).toHaveLength(5);
    expect(harness.workerInputs[2]?.prompt).toContain("select_state_machine_state");
    expect(harness.workerInputs[3]?.prompt).toContain("retry 2 of 3");
    expect(harness.workerInputs[4]?.prompt).toContain("retry 3 of 3");
    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: "State completed, but the runner did not call select_state_machine_state.",
    });
  });

  test("cannot create a new state-machine definition while one is active", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("waiting_for_reply");
    const definition = {
      name: "follow_up_flow",
      prompt: "Use after outreach needs a new follow-up process.",
      states: [
        {
          kind: "terminal" as const,
          name: "done",
          status: "completed" as const,
        },
      ],
    };
    harness.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: { kind: "run_state", state: "research_prospect" },
      },
      { type: "none" },
      {
        type: "create_state_machine_definition",
        definition,
        firstState: "done",
      },
    );

    const terminal = await harness.turn({
      type: "prompt",
      run,
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error:
        "Cannot create a new state-machine definition while the current state machine is still active.",
    });
  });

  test("can create a new state-machine definition after the previous one is terminal", async () => {
    const { harness } = createHarness();
    const run = createStateMachineRun("meeting_scheduled");
    assert(run.stateMachine);
    const terminalRun = {
      ...run,
      stateMachine: {
        ...run.stateMachine,
        terminal: { state: "meeting_scheduled", status: "completed" as const },
      },
    };
    const definition = {
      name: "follow_up_flow",
      prompt: "Use after a completed outreach process needs follow-up.",
      states: [
        {
          kind: "terminal" as const,
          name: "done",
          status: "completed" as const,
        },
      ],
    };
    harness.controlResults.push({
      type: "create_state_machine_definition",
      definition,
      firstState: "done",
    });

    const terminal = await harness.turn({
      type: "prompt",
      run: terminalRun,
      message: "Start a follow-up process.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      run: {
        stateMachine: {
          definition,
          currentState: "done",
          terminal: { state: "done", status: "completed" },
        },
      },
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

  test("routes answers back to the current agent state when it is waiting for human input", async () => {
    const { harness } = createHarness();
    const run = {
      ...createStateMachineRun("research_prospect"),
      status: "waiting_for_human" as const,
    };
    harness.controlResults.push(
      { type: "none" },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );

    const terminal = await harness.turn({
      type: "answer",
      run,
      questions: [{ question: "Which prospect?", options: [{ label: "Ada" }] }],
      answers: { prospect: "Ada Lovelace" },
      behavior: "follow_up",
    });

    expect(harness.workerInputs).toHaveLength(2);
    const answerMessage = harness.workerInputs[0]?.run.agent.messages.at(-1);
    expect(answerMessage).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
        },
      ],
    });
    const answerContent = answerMessage?.role === "user" ? answerMessage.content : undefined;
    const answerText =
      typeof answerContent === "string"
        ? answerContent
        : Array.isArray(answerContent) && answerContent[0]?.type === "text"
          ? answerContent[0].text
          : "";
    expect(answerText).toContain("Here are my answers to your questions.");
    expect(answerText).toContain("Ada Lovelace");
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      run: {
        status: "completed",
        stateMachine: {
          currentState: "meeting_scheduled",
          terminal: { state: "meeting_scheduled", status: "completed" },
        },
      },
    });
  });
});
