import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import {
  createTurnRunner,
  createOutreachStateMachine,
  createStateMachineState,
} from "./helpers/turn-runner-protocol.js";

describe("TurnRunner protocol scenarios", () => {
  test("runs a simple auto-classified prompt in agent mode", async () => {
    const { runner, events } = createTurnRunner();

    const terminal = await runner.turn({
      type: "start",
      prompt: "Summarize this file.",
      mode: "auto",
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "session_started",
      state: { status: "running", mode: "auto", agent: { status: "running" } },
    });
    expect(events.some((event) => event.type === "state_machine")).toBe(false);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { status: "completed", agent: { status: "completed" } },
    });
    expect(terminal.state.stateMachine).toBeUndefined();
  });

  test("auto-selects a valid state machine for a long-running lifecycle and streams UI state", async () => {
    const { runner, events } = createTurnRunner();
    const prompt = "Prospect Ada until she books a meeting.";
    const definition = createOutreachStateMachine();
    runner.controlResults.push({
      type: "create_state_machine_definition",
      definition,
      firstState: "research_prospect",
    });

    const terminal = await runner.turn({
      type: "start",
      prompt,
      mode: "auto",
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "session_started",
      state: {
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
    expect(terminal.state.stateMachine).toBeDefined();
    expect(terminal.state.mode).toBe("auto");
    expect(terminal.state.stateMachine?.definition).toBeDefined();
    expect(
      terminal.state.stateMachine?.history.some((event) => event.type === "state_completed"),
    ).toBe(true);

    expect(runner.workerInputs[0]?.tools.map((tool) => tool.name)).toContain(
      "create_state_machine_definition",
    );
  });

  test("uses a steering prompt to update and continue an active state-machine session", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "classify_reply" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "I've already received this email: yes, happy to meet next week.",
      behavior: "steer",
    });

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");
    expect(terminal.state.agent.messages.at(-1)).toMatchObject({
      role: "assistant",
    });
    expect(terminal.state.stateMachine?.currentState).not.toBe("waiting_for_reply");
  });

  test("answers unrelated prompts during an active state-machine session without changing state", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "What is the capital of France?",
      behavior: "follow_up",
    });

    expect(events.some((event) => event.type === "state_machine")).toBe(false);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
      state: {
        status: "completed",
        stateMachine: { currentState: "waiting_for_reply" },
      },
    });
  });

  test("sleeps between poll attempts while waiting for an external email response", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("poll_email_reply");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "poll_email_reply" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue polling.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      state: {
        status: "sleeping",
        mode: "auto",
        agent: { status: "completed" },
        stateMachine: { currentState: "poll_email_reply" },
      },
    });
    expect(terminal.type === "sleep" ? terminal.wakeAt : 0).toBeGreaterThan(Date.now());
  });

  test("wakes a sleeping poll session for one polling attempt", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };

    const terminal = await runner.turn({
      type: "wake",
      state: turnState,
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      state: {
        status: "sleeping",
        stateMachine: { currentState: "poll_email_reply" },
      },
    });
  });

  test("wake is a no-op when the session is not sleeping on a poll", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");

    const terminal = await runner.turn({
      type: "wake",
      state: turnState,
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: "Nothing to wake.",
      state: turnState,
    });
  });

  test("interrupts a running turn and resolves it with the current session", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("send_email");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "fail", reason: "Interrupted" },
    });

    const turn = runner.turn({
      type: "prompt",
      state: turnState,
      message: "Send the email now.",
      behavior: "steer",
    });
    const terminal = await turn;

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      state: {
        status: "failed",
        mode: "auto",
        agent: { status: "completed" },
        stateMachine: { currentState: "send_email" },
      },
    });
  });

  test("runs an explicit state machine when the prompt matches the definition", async () => {
    const { runner, events } = createTurnRunner();
    const definition = createOutreachStateMachine();
    const prompt = "Prospect Ada until she books a meeting.";
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    const terminal = await runner.turn({
      type: "start",
      prompt,
      mode: definition,
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "session_started",
      state: {
        status: "running",
        mode: definition,
        agent: { status: "running" },
      },
    });
    expect(terminal.state.stateMachine).toBeDefined();
    expect(terminal.state.mode).toBe(definition);
    expect(terminal.state.stateMachine?.definition).toBe(definition);

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");

    expect(runner.workerInputs[0]?.tools.map((tool) => tool.name)).not.toContain(
      "create_state_machine_definition",
    );
    expect(runner.workerInputs[0]?.appendSystemPrompt).toContain(
      "Explicit state-machine definition",
    );
    expect(runner.workerInputs[0]?.appendSystemPrompt).toContain('"name": "conference_outreach"');
    expect(runner.workerInputs[0]?.appendSystemPrompt).toContain('"name": "research_prospect"');
  });

  test("answers normally when an explicit state machine does not fit the prompt", async () => {
    const { runner, events } = createTurnRunner();
    const definition = createOutreachStateMachine();

    const terminal = await runner.turn({
      type: "start",
      prompt: "What is the capital of France?",
      mode: definition,
    });

    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events[1]).toMatchObject({
      type: "session_started",
      state: { status: "running", mode: definition, agent: { status: "running" } },
    });
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: expect.stringContaining("Paris"),
    });
    expect(terminal.state.stateMachine).toBeUndefined();
  });

  test("reports valid states when the runner selects an invalid state", async () => {
    const { runner } = createTurnRunner();
    const definition = createOutreachStateMachine();
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "invented_state" },
    });

    const terminal = await runner.turn({
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
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: {
        kind: "run_state",
        state: "research_prospect",
        override: { kind: "agent", state: { prompt: "Research Grace Hopper." } },
      },
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Focus on Grace.",
      behavior: "steer",
    });

    const started = terminal.state.stateMachine?.history.find(
      (event) => event.type === "state_started",
    );
    expect(started?.type === "state_started" ? started.effectiveState : undefined).toMatchObject({
      prompt: "Research Grace Hopper.",
    });
    expect(terminal.state.stateMachine?.definition.states[0]).toMatchObject({
      prompt: "Research the prospect and company.",
    });
  });

  test("bounds state-machine history injected into agent state prompts", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "waiting_for_reply" && state.kind === "agent"
          ? { ...state, contextScope: "state_machine" }
          : state,
      ),
    };
    turnState.stateMachine.history = [
      {
        type: "state_completed",
        timestamp: 1,
        state: "research_prospect",
        output: { marker: "old-history", data: "x".repeat(20_000) },
      },
      {
        type: "state_completed",
        timestamp: 2,
        state: "send_email",
        output: { marker: "recent-history" },
      },
    ];
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "waiting_for_reply" },
    });

    await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue outreach.",
      behavior: "follow_up",
    });

    const agentStatePrompt = runner.workerInputs[1]?.prompt ?? "";
    const agentStateSystemPrompt = runner.workerInputs[1]?.appendSystemPrompt ?? "";
    expect(agentStatePrompt.includes("recent-history")).toBe(true);
    expect(agentStatePrompt.includes("old-history")).toBe(false);
    expect(agentStatePrompt.includes('"omitted": 1')).toBe(true);
    expect(agentStateSystemPrompt.includes("recent-history")).toBe(false);
    expect(agentStateSystemPrompt.includes("old-history")).toBe(false);
    expect(agentStateSystemPrompt.includes("State-machine context:")).toBe(true);
  });

  test("asks the parent runner for the next state immediately after a state completes", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    runner.controlResults.push(
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

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(3);
    expect(runner.workerInputs[2]?.prompt).toContain('The state "research_prospect" finished.');
    expect(events.filter((event) => event.type === "state_machine")).toHaveLength(2);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: {
        status: "completed",
        stateMachine: {
          currentState: "meeting_scheduled",
          terminal: { state: "meeting_scheduled", status: "completed" },
        },
      },
    });
  });

  test("retries when the parent runner does not choose the next state after completion", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(5);
    expect(runner.workerInputs[2]?.prompt).toContain("select_state_machine_state");
    expect(runner.workerInputs[3]?.prompt).toContain("retry 2 of 3");
    expect(runner.workerInputs[4]?.prompt).toContain("retry 3 of 3");
    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: "State completed, but the runner did not call select_state_machine_state.",
    });
  });

  test("cannot create a new state-machine definition while one is active", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
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
    runner.controlResults.push(
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

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
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
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("meeting_scheduled");
    assert(turnState.stateMachine);
    const terminalState = {
      ...turnState,
      stateMachine: {
        ...turnState.stateMachine,
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
    runner.controlResults.push({
      type: "create_state_machine_definition",
      definition,
      firstState: "done",
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: terminalState,
      message: "Start a follow-up process.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: {
        stateMachine: {
          definition,
          currentState: "done",
          terminal: { state: "done", status: "completed" },
        },
      },
    });
  });

  test("bubbles an agent state's ask terminal status to the parent turn runner", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });
    let calls = 0;
    runner.worker = async (input, next) => {
      calls += 1;
      if (calls === 2) {
        return {
          control: { type: "none" },
          terminal: {
            type: "ask",
            questions: [{ question: "Need detail?", options: [{ label: "Yes" }] }],
            state: { ...input.state, status: "waiting_for_human" },
          },
        };
      }
      return next();
    };

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue.",
      behavior: "steer",
    });

    expect(terminal).toMatchObject({ type: "ask", state: { status: "waiting_for_human" } });
  });

  test("routes answers back to the current agent state when it is waiting for human input", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("research_prospect"),
      status: "waiting_for_human" as const,
    };
    runner.controlResults.push(
      { type: "none" },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );

    const terminal = await runner.turn({
      type: "answer",
      state: turnState,
      questions: [{ question: "Which prospect?", options: [{ label: "Ada" }] }],
      answers: { prospect: "Ada Lovelace" },
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(2);
    const answerMessage = runner.workerInputs[0]?.state.agent.messages.at(-1);
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
      state: {
        status: "completed",
        stateMachine: {
          currentState: "meeting_scheduled",
          terminal: { state: "meeting_scheduled", status: "completed" },
        },
      },
    });
  });
});
