import { describe, expect, test } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
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
      type: "turn_started",
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

  test("prepends a system reminder when a turn starts with carried-over todos", async () => {
    const { runner } = createTurnRunner();
    await runner.start({
      type: "start",
      mode: "agent",
      state: {
        status: "running",
        mode: "agent",
        agent: { status: "running", messages: [] },
        todos: [
          { id: "test", content: "Run tests", status: "in_progress" },
          { id: "verify", content: "Verify behavior", status: "pending" },
          { id: "plan", content: "Plan the work", status: "completed" },
        ],
      },
    });

    await runner.turn({ type: "prompt", message: "Continue the work.", behavior: "follow_up" });

    expect(runner.workerInputs).toHaveLength(1);
    const sentPrompt = runner.workerInputs[0]?.prompt ?? "";
    expect(sentPrompt).toContain("<system-reminder>");
    expect(sentPrompt).toContain(
      "You have an existing todo list from earlier in this conversation",
    );
    expect(sentPrompt).toContain("- [in_progress] test: Run tests");
    expect(sentPrompt).toContain("- [pending] verify: Verify behavior");
    expect(sentPrompt).toContain("- [completed] plan: Plan the work");
    expect(sentPrompt).toContain(
      "call todo_write with merge=false and an empty todos array to clear it",
    );
    expect(sentPrompt.endsWith("Continue the work.")).toBe(true);
  });

  test("does not prepend a todo reminder when all carried todos are terminal", async () => {
    const { runner } = createTurnRunner();
    await runner.start({
      type: "start",
      mode: "agent",
      state: {
        status: "running",
        mode: "agent",
        agent: { status: "running", messages: [] },
        todos: [
          { id: "plan", content: "Plan the work", status: "completed" },
          { id: "test", content: "Run tests", status: "failed" },
        ],
      },
    });

    await runner.turn({ type: "prompt", message: "Continue the work.", behavior: "follow_up" });

    const sentPrompt = runner.workerInputs[0]?.prompt ?? "";
    expect(sentPrompt).toBe("Continue the work.");
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
      type: "turn_started",
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

    expect(runner.agentConfigs[0]?.tools.map((tool) => tool.name)).toContain(
      "create_state_machine_definition",
    );
  });

  test("terminal usage includes state-machine state-agent usage", async () => {
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
      {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.11 },
      },
      {
        input: 20,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 22,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.22 },
      },
      {
        input: 30,
        output: 3,
        cacheRead: 4,
        cacheWrite: 0,
        totalTokens: 33,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.33 },
      },
    ];
    let workerIndex = 0;
    runner.worker = async (input, next) => {
      const result = await next();
      const usage = usageByWorker[workerIndex++]!;
      result.parentUsage = usage;
      result.outcome.state.agent.messages = [
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
      turnUsage: {
        input: 60,
        output: 6,
        totalTokens: 66,
        cacheRead: 4,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.66 },
      },
    });
  });

  test("uses a steering prompt to update and continue an active state-machine session", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    const stateMachine = turnState.stateMachine;
    assert(stateMachine);
    await runner.start({
      type: "start",
      state: {
        ...turnState,
        stateMachine: {
          ...stateMachine,
          progress: {
            states: {
              poll_email_reply: {
                kind: "poll",
                runs: 1,
                sleeps: 1,
                nextWakeAt: Date.now() + 60_000,
              },
            },
          },
        },
      },
    });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "classify_reply" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      message: "I've already received this email: yes, happy to meet next week.",
      behavior: "steer",
    });

    const stateMachineEvent = events.find((event) => event.type === "state_machine");
    expect(stateMachineEvent).toMatchObject({ type: "state_machine" });
    expect(
      stateMachineEvent?.type === "state_machine" ? stateMachineEvent.currentState : "",
    ).not.toBe("");
    expect(terminal.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_started", state: "classify_reply" }),
    );
    expect(terminal.state.stateMachine?.currentState).not.toBe("waiting_for_reply");
    expect(terminal.state.stateMachine?.progress?.states.poll_email_reply?.nextWakeAt).toBe(
      undefined,
    );
  });

  test("answers unrelated prompts during an active state-machine session without changing state", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    await runner.start({ type: "start", state: turnState });

    const terminal = await runner.turn({
      type: "prompt",
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

  test("answers unrelated prompts after poll interruption without terminalizing the state machine", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("poll_email_reply");
    const stateMachine = turnState.stateMachine;
    assert(stateMachine);
    await runner.start({
      type: "start",
      state: {
        ...turnState,
        status: "interrupted",
        stateMachine: {
          ...stateMachine,
          currentState: "interrupted",
          currentInput: undefined,
          terminal: undefined,
          history: [
            ...stateMachine.history,
            { type: "state_started", timestamp: Date.now(), state: "poll_email_reply" },
            {
              type: "state_interrupted",
              timestamp: Date.now(),
              state: "poll_email_reply",
              reason: "Interrupted",
            },
          ],
        },
      },
    });

    const terminal = await runner.turn({
      type: "prompt",
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
        stateMachine: { currentState: "interrupted" },
      },
    });
    expect(terminal.state.stateMachine?.terminal).toBeUndefined();
    expect(terminal.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_interrupted", state: "poll_email_reply" }),
    );
  });

  test("sleeps between poll attempts while waiting for an external email response", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("poll_email_reply");
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "poll_email_reply" },
    });

    const terminal = await runner.turn({
      type: "prompt",
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
    expect(terminal.state.stateMachine?.progress?.states.poll_email_reply).toMatchObject({
      runs: 1,
      sleeps: 1,
      nextWakeAt: terminal.type === "sleep" ? terminal.wakeAt : expect.any(Number),
    });
  });

  test("wakes a sleeping poll session for one polling attempt", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    await runner.start({ type: "start", state: turnState });

    const terminal = await runner.turn({
      type: "wake",
    });

    expect(terminal).toMatchObject({
      type: "sleep",
      state: {
        status: "sleeping",
        stateMachine: { currentState: "poll_email_reply" },
      },
    });
    expect(terminal.state.stateMachine?.progress?.states.poll_email_reply).toMatchObject({
      sleeps: 1,
      nextWakeAt: terminal.type === "sleep" ? terminal.wakeAt : expect.any(Number),
    });
  });

  test("wake is a no-op when the session is not sleeping on a poll", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    await runner.start({ type: "start", state: turnState });

    const terminal = await runner.turn({
      type: "wake",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: "Nothing to wake.",
    });
  });

  test("interrupts a running turn and resolves it with the current session", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("send_email");
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "fail", reason: "Interrupted" },
    });

    const turn = runner.turn({
      type: "prompt",
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
      type: "turn_started",
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

    expect(runner.agentConfigs[0]?.tools.map((tool) => tool.name)).not.toContain(
      "create_state_machine_definition",
    );
    expect(runner.agentConfigs[0]?.appendSystemPrompt).toContain(
      "Explicit state-machine definition",
    );
  });

  test("answers normally when an explicit state machine does not fit the prompt", async () => {
    const { runner, events } = createTurnRunner();
    const definition = createOutreachStateMachine();

    const terminal = await (
      await startTurn(runner, { mode: definition, prompt: "What is the capital of France?" })
    ).turn;

    expect(events[0]).toMatchObject({
      type: "turn_started",
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
    await runner.start({ type: "start", state: turnState });
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
    await runner.start({ type: "start", state: turnState });
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
      message: "Continue outreach.",
      behavior: "follow_up",
    });

    const agentStatePrompt = runner.stateAgentInputs[0]?.prompt ?? "";
    const agentStateSystemPrompt = runner.stateAgentInputs[0]?.appendSystemPrompt ?? "";
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
    await runner.start({ type: "start", state: turnState });
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
      message: "Continue outreach.",
      behavior: "follow_up",
    });

    const stateAgentInput = runner.stateAgentInputs[0];
    expect(stateAgentInput?.skills?.map((skill) => skill.name)).toEqual(["allowed-skill"]);
  });

  test("asks the parent runner for the next state immediately after a state completes", async () => {
    const { runner, events } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    await runner.start({ type: "start", state: turnState });
    // 4 parent invocations: (1) initial state pick, (2) state-completed
    // continuation, (3) terminal selection, (4) terminal acknowledgment
    // turn (where the parent gets to summarize the outcome to the user).
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
      { type: "none" },
    );

    const terminal = await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(4);
    expect(runner.workerInputs[2]?.prompt).toContain('The state "research_prospect" finished.');
    expect(runner.workerInputs[3]?.prompt).toContain(
      'The state machine "conference_outreach" has reached a terminal state',
    );
    expect(runner.workerInputs[3]?.prompt).toContain("<status>completed</status>");
    expect(runner.workerInputs[3]?.prompt).toContain("<state>meeting_scheduled</state>");
    expect(events.filter((event) => event.type === "state_machine")).toHaveLength(2);
    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: {
        status: "completed",
        stateMachine: {
          currentState: "meeting_scheduled",
          terminal: { state: "meeting_scheduled", status: "completed" },
          terminalAcknowledged: true,
        },
      },
    });
  });

  test("renders parent-provided transition input into agent prompts", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("research_prospect");
    await runner.start({ type: "start", state: turnState });
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
          outcome: {
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
  });

  test("timer state forwards elapsed output on wake", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("wait_before_retry"),
      status: "sleeping" as const,
    };
    const startedAt = Date.now() - 12_000;
    turnState.stateMachine?.history.push({
      type: "state_started",
      timestamp: startedAt,
      state: "wait_before_retry",
    });
    runner.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "meeting_scheduled" },
      },
      // Terminal acknowledgment turn: parent replies in plain text.
      { type: "none" },
    );
    await runner.start({ type: "start", state: turnState });

    const terminal = await runner.turn({
      type: "wake",
    });

    expect(runner.workerInputs).toHaveLength(2);
    const parentPrompt = runner.workerInputs[0]?.prompt ?? "";
    expect(parentPrompt).toContain('The state "wait_before_retry" finished.');
    expect(runner.workerInputs[1]?.prompt).toContain("has reached a terminal state");
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

  test("timer state sleeps when first selected before producing output on wake", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("wait_before_retry");
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "wait_before_retry" },
    });

    const terminal = await runner.turn({
      type: "prompt",
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

  test("timer state can sleep until an absolute wakeAt before continuing transitions", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("wait_before_retry");
    const wakeAt = Date.now() + 60_000;
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "wait_before_retry" && state.kind === "timer" ? { ...state, wakeAt } : state,
      ),
    };
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "wait_before_retry" },
    });

    const sleeping = await runner.turn({
      type: "prompt",
      message: "Wait until the absolute time.",
      behavior: "follow_up",
    });

    expect(sleeping).toMatchObject({
      type: "sleep",
      wakeAt,
      state: {
        status: "sleeping",
        stateMachine: { currentState: "wait_before_retry" },
      },
    });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "terminal", state: "meeting_scheduled" },
    });

    const terminal = await runner.turn({ type: "wake" });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: { stateMachine: { terminal: { state: "meeting_scheduled" } } },
    });
    const completed = terminal.state.stateMachine?.history.find(
      (event) => event.type === "state_completed" && event.state === "wait_before_retry",
    );
    const output = completed?.type === "state_completed" ? completed.output : undefined;
    expect(output).toMatchObject({
      elapsedMs: expect.any(Number),
      timestamp: expect.any(Number),
    });
  });

  test("poll timeout fails after the maximum time in the poll state", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    const startedAt = Date.now() - 10_000;
    if (!turnState.stateMachine) throw new Error("Expected state machine session");
    turnState.stateMachine.definition = {
      ...turnState.stateMachine.definition,
      states: turnState.stateMachine.definition.states.map((state) =>
        state.name === "poll_email_reply" && state.kind === "poll"
          ? { ...state, timeoutMs: 5_000 }
          : state,
      ),
    };
    turnState.stateMachine.history.push({
      type: "state_started",
      timestamp: startedAt,
      state: "poll_email_reply",
    });
    await runner.start({ type: "start", state: turnState });

    const terminal = await runner.turn({
      type: "wake",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: expect.stringContaining('Poll state "poll_email_reply" timed out'),
    });
    expect(terminal.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({
        type: "state_failed",
        state: "poll_email_reply",
      }),
    );
    expect(terminal.state.stateMachine?.history.at(-1)).toMatchObject({
      type: "state_machine_completed",
      terminal: {
        state: "poll_email_reply",
        status: "failed",
      },
    });
  });

  test("script states honor successCodes and forward stdout plus parsed state", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("send_email");
    await runner.start({ type: "start", state: turnState });
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
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    const terminal = await runner.turn({
      type: "prompt",
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
    await runner.start({ type: "start", state: turnState });
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
    await runner.start({ type: "start", state: turnState });
    assert(turnState.stateMachine);
    const terminalState = {
      ...turnState,
      stateMachine: {
        ...turnState.stateMachine,
        terminal: { state: "meeting_scheduled", status: "completed" as const },
      },
    };
    await runner.start({ type: "start", state: terminalState });
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
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });
    let calls = 0;
    runner.worker = async (input, next) => {
      calls += 1;
      if (calls === 2) {
        return {
          control: {
            type: "ask_user_question",
            questions: [{ question: "Need detail?", options: [{ label: "Yes" }] }],
          },
          outcome: {
            type: "complete",
            status: "completed",
            result: "",
            state: { ...input.state, status: "waiting_for_human" },
          },
        };
      }
      return next();
    };

    const terminal = await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "steer",
    });

    expect(terminal).toMatchObject({ type: "ask", state: { status: "waiting_for_human" } });
  });

  test("routes answers through the parent after an agent state asks for human input", async () => {
    const { runner } = createTurnRunner();
    const turnState = {
      ...createStateMachineState("research_prospect"),
      status: "waiting_for_human" as const,
    };
    await runner.start({ type: "start", state: turnState });
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
      // Terminal acknowledgment turn.
      { type: "none" },
    );

    const terminal = await runner.turn({
      type: "answer",
      questions: [{ question: "Which prospect?", options: [{ label: "Ada" }] }],
      answers: { prospect: ["Ada Lovelace"] },
      behavior: "follow_up",
    });

    expect(runner.workerInputs).toHaveLength(4);
    const answerText = runner.workerInputs[0]?.prompt ?? "";
    expect(answerText).toContain("Here are my answers to your questions.");
    expect(answerText).toContain("Ada Lovelace");
    expect(
      terminal.state.stateMachine?.history.some(
        (event) =>
          event.type === "state_started" &&
          event.state === "research_prospect" &&
          event.input?.prospect === "Ada Lovelace",
      ),
    ).toBe(true);
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

  test("replaces active state work when the parent selects a state again", async () => {
    const { runner } = createTurnRunner();
    const turnState = createStateMachineState("waiting_for_reply");
    await runner.start({ type: "start", state: turnState });
    runner.controlResults.push({
      type: "select_state_machine_state",
      decision: { kind: "run_state", state: "research_prospect" },
    });

    const terminal = await runner.turn({
      type: "prompt",
      message: "Ada replied yes.",
      behavior: "follow_up",
    });

    expect(runner.workerInputs.length).toBeGreaterThan(1);
    expect(terminal.state.stateMachine?.currentState).toBe("research_prospect");
  });
});
