import { describe, expect, test } from "bun:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import assert from "node:assert";
import {
  createTurnRunner,
  createOutreachStateMachine,
  createStateMachineState,
  startTurn,
} from "./helpers/turn-runner-protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

describe("TurnRunner protocol scenarios", () => {
  test("runs a simple auto-classified prompt in agent mode", async () => {
    const { runner, events } = createTurnRunner();

    const terminal = await (
      await startTurn(runner, { mode: "auto", prompt: "Summarize this file." })
    ).turn;

    expect(events[0]).toMatchObject({
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

  test("asks the user structured questions from agent mode", async () => {
    const { runner } = createTurnRunner();
    runner.controlResults.push({
      type: "ask_user_question",
      questions: [
        {
          question: "Which branch should I deploy?",
          options: [{ label: "main" }, { label: "release" }],
        },
      ],
    });

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "Deploy the app." })
    ).turn;

    expect(terminal).toMatchObject({
      type: "ask",
      questions: [
        {
          question: "Which branch should I deploy?",
          options: [{ label: "main" }, { label: "release" }],
        },
      ],
      state: { status: "waiting_for_human" },
    });
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

    const terminal = await (await startTurn(runner, { mode: "auto", prompt })).turn;

    expect(events[0]).toMatchObject({
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

  test("terminal usage includes state-machine child agent usage", async () => {
    const { runner } = createTurnRunner();
    const definition = createOutreachStateMachine();
    runner.controlResults.push(
      {
        type: "create_state_machine_definition",
        definition,
        firstState: "research_prospect",
      },
      { type: "none" },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );
    const usageByWorker = [
      { inputTokens: 10, outputTokens: 1, costUsd: 0.11 },
      { inputTokens: 20, outputTokens: 2, costUsd: 0.22 },
      { inputTokens: 30, outputTokens: 3, cachedInputTokens: 4, costUsd: 0.33 },
    ];
    let workerIndex = 0;
    runner.worker = async (input, next) => {
      const result = await next();
      const usage = usageByWorker[workerIndex++]!;
      result.terminal.usage = usage;
      result.terminal.state.agent.messages = [
        ...input.state.agent.messages,
        createAssistantMessage({ text: `worker ${workerIndex}`, timestamp: Date.now() }),
      ];
      return result;
    };

    const terminal = await (
      await startTurn(runner, { mode: "auto", prompt: "Prospect Ada until she books a meeting." })
    ).turn;

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      usage: {
        inputTokens: 60,
        outputTokens: 6,
        cachedInputTokens: 4,
        costUsd: 0.66,
      },
    });
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

    const terminal = await (await startTurn(runner, { mode: definition, prompt })).turn;

    expect(events[0]).toMatchObject({
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

    const terminal = await (
      await startTurn(runner, { mode: definition, prompt: "What is the capital of France?" })
    ).turn;

    expect(events[0]).toMatchObject({
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

    const terminal = await (
      await startTurn(runner, {
        mode: definition,
        prompt: "Prospect Ada until she books a meeting.",
      })
    ).turn;

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

    expect(runner.workerInputs[1]?.prompt).toBe("Research Grace Hopper.");
    expect(terminal.state.stateMachine?.definition.states[0]).toMatchObject({
      prompt: "Research the prospect and company.",
    });
  });

  test("uses optional state agent system prompts without injecting state-machine context", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "waiting_for_reply" && state.kind === "agent"
          ? { ...state, systemPrompt: "You are handling the waiting state." }
          : state,
      ),
    };
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
    expect(agentStatePrompt).toBe("Wait for or incorporate the prospect reply.");
    expect(agentStateSystemPrompt).toBe("You are handling the waiting state.");
  });

  test("restricts injected skills for state-machine agent states", async () => {
    const { runner } = createTurnRunner({
      skills: [
        {
          name: "allowed-skill",
          description: "Allowed skill.",
          baseDir: "/tmp/allowed-skill",
          filePath: "/tmp/allowed-skill/SKILL.md",
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
        {
          name: "blocked-skill",
          description: "Blocked skill.",
          baseDir: "/tmp/blocked-skill",
          filePath: "/tmp/blocked-skill/SKILL.md",
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });
    const turnState = createStateMachineState("research_prospect");
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "research_prospect" && state.kind === "agent"
          ? { ...state, allowedSkills: ["allowed-skill"] }
          : state,
      ),
    };
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue outreach.",
      behavior: "follow_up",
    });

    const childInput = runner.workerInputs[1];
    expect(childInput?.skills?.map((skill) => skill.name)).toEqual(["allowed-skill"]);
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

  test("renders parent-provided transition input into agent prompts", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    assert(turnState.stateMachine);
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "research_prospect" && state.kind === "agent"
          ? {
              ...state,
              inputSchema: {
                type: "object",
                properties: {
                  prospect: { type: "string" },
                },
                required: ["prospect"],
              },
              prompt: "Research {{ input.prospect }}.",
            }
          : state,
      ),
    };
    runner.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: {
          kind: "run_state",
          state: "research_prospect",
          input: { prospect: "Ada Lovelace" },
        },
      },
      { type: "none" },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );
    let calls = 0;
    runner.worker = async (input, next) => {
      calls += 1;
      if (calls === 2) {
        runner.workerInputs.push(input);
        return {
          control: { type: "none" },
          terminal: {
            type: "complete",
            status: "completed",
            result: "Research complete.",
            state: {
              ...input.state,
              status: "completed",
              agent: { ...input.state.agent, status: "completed" },
            },
          },
        };
      }
      return next();
    };

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Continue.",
      behavior: "follow_up",
    });

    const started = terminal.state.stateMachine?.history.find(
      (event) => event.type === "state_started" && event.state === "research_prospect",
    );
    expect(started?.type === "state_started" ? started.input : undefined).toMatchObject({
      prospect: "Ada Lovelace",
    });
    expect(runner.workerInputs[1]?.prompt).toContain("Research Ada Lovelace.");
    const parentPrompt = runner.workerInputs[2]?.prompt ?? "";
    expect(parentPrompt).toContain("<output>");
    expect(parentPrompt).toContain("Research complete.");
    expect(parentPrompt).toContain("childStatus");
    expect(parentPrompt).toContain("<terminal>");
  });

  test("timer poll continues without script and forwards elapsed output", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("wait_before_retry");
    const startedAt = Date.now() - 12_000;
    turnState.stateMachine?.history.push({
      type: "state_started",
      timestamp: startedAt,
      state: "wait_before_retry",
    });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "terminal", state: "meeting_scheduled" },
    });

    const terminal = await runner.turn({
      type: "wake",
      state: { ...turnState, status: "sleeping" },
    });

    expect(runner.workerInputs).toHaveLength(1);
    const parentPrompt = runner.workerInputs[0]?.prompt ?? "";
    expect(parentPrompt).toContain('The state "wait_before_retry" finished.');
    expect(parentPrompt).toContain("<elapsedMs>");
    expect(parentPrompt).toContain("<output>");
    const completed = terminal.state.stateMachine?.history.find(
      (event) =>
        event.type === "state_completed" &&
        event.state === "wait_before_retry" &&
        typeof (event.output as { elapsedMs?: unknown } | undefined)?.elapsedMs === "number",
    );
    expect(completed).toBeDefined();
    const output = completed?.type === "state_completed" ? completed.output : undefined;
    expect((output as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(12_000);
  });

  test("timer poll sleeps when first selected before producing output on wake", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("wait_before_retry");
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "wait_before_retry" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Wait before retrying.",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      state: {
        status: "sleeping",
        stateMachine: { currentState: "wait_before_retry" },
      },
    });
    expect(terminal.state.stateMachine?.history.at(-1)).toMatchObject({ type: "state_started" });
    expect(runner.workerInputs).toHaveLength(1);
  });

  test("poll timeout fails after the maximum time in the poll state", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("wait_before_retry");
    const startedAt = Date.now() - 10_000;
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "wait_before_retry" && state.kind === "poll"
          ? { ...state, timeoutMs: 5_000 }
          : state,
      ),
    };
    turnState.stateMachine.history.push({
      type: "state_started",
      timestamp: startedAt,
      state: "wait_before_retry",
    });

    const terminal = await runner.turn({
      type: "wake",
      state: { ...turnState, status: "sleeping" },
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: expect.stringContaining('Poll state "wait_before_retry" timed out'),
    });
    expect(terminal.state.stateMachine?.history.at(-1)).toMatchObject({
      type: "state_failed",
      state: "wait_before_retry",
    });
  });

  test("script states honor successCodes and forward stdout plus parsed state", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("send_email");
    runner.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: {
          kind: "run_state",
          state: "send_email",
          override: {
            kind: "script",
            state: {
              command: 'printf \'{"sent":true,"messageId":"msg_123"}\'; printf "warn" >&2; exit 2',
              successCodes: [2],
            },
          },
          input: { email: "ada@example.com" },
        },
      },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
    );

    const terminal = await runner.turn({
      type: "prompt",
      state: turnState,
      message: "Send the email.",
      behavior: "follow_up",
    });

    const started = terminal.state.stateMachine?.history.find(
      (event) => event.type === "state_started" && event.state === "send_email",
    );
    expect(started?.type === "state_started" ? started.input : undefined).toMatchObject({
      email: "ada@example.com",
    });
    const parentPrompt = runner.workerInputs[1]?.prompt ?? "";
    expect(parentPrompt).toContain("<stdout>");
    expect(parentPrompt).toContain("<stderr>warn</stderr>");
    expect(parentPrompt).toContain("<exitCode>2</exitCode>");
    expect(parentPrompt).toContain("msg_123");
    expect(parentPrompt).toContain("<sent>true</sent>");
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

  test("lets the parent runner prompt the current state-machine agent", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    runner.controlResults.push(
      {
        type: "prompt_state_machine_agent",
        prompt: "Use the user's answer to continue the waiting state.",
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
      message: "Ada replied yes.",
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(3);
    expect(runner.workerInputs[1]?.prompt).toBe(
      "Use the user's answer to continue the waiting state.",
    );
    expect(runner.workerInputs[1]?.appendSystemPrompt).toBeUndefined();
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: {
        stateMachine: {
          terminal: { state: "meeting_scheduled", status: "completed" },
        },
      },
    });
  });
});
