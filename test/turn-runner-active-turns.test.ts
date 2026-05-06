import { describe, expect, test } from "bun:test";
import { Agent } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class StreamingTurnRunner extends TurnRunner {
  readonly contexts: Context[] = [];
  readonly pendingStreams: ReturnType<typeof createAssistantMessageEventStream>[] = [];

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override createAgent(
    input: AgentWorkerInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = (_model, context) => {
      this.contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      const stream = createAssistantMessageEventStream();
      this.pendingStreams.push(stream);
      return stream;
    };
    return agent;
  }

  completeNext(text: string, options?: { error?: string }): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "stop",
      message: createAssistantMessage(text, options?.error),
    });
  }

  completeNextToolCall(name: string, args: Record<string, unknown>): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "toolUse",
      message: createAssistantMessage("", undefined, [
        { type: "toolCall", id: `tool_${this.contexts.length}`, name, arguments: args },
      ]),
    });
  }
}

describe("TurnRunner active turns", () => {
  test("repeated prompt turns join the active agent chain and emit one terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "first" });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const second = runner.turn({
      type: "prompt",
      state,
      message: "second",
      behavior: "follow_up",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("second response");

    const [firstTerminal, secondTerminal] = await Promise.all([first, second]);
    expect(firstTerminal).toBe(secondTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(firstTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(messageTexts(firstTerminal.state)).toEqual([
      "first",
      "first response",
      "second",
      "second response",
    ]);
  });

  test("steer is handled through turn and still shares the active terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "first" });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const steer = runner.turn({
      type: "prompt",
      state,
      message: "steer now",
      behavior: "steer",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("steered response");

    const [firstTerminal, steerTerminal] = await Promise.all([first, steer]);
    expect(firstTerminal).toBe(steerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(messageTexts(firstTerminal.state)).toContain("steer now");
  });

  test("answers behave like prompts after serialization during active turns", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "ask me later" });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      state,
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { choice: "A" },
      behavior: "follow_up",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("answer response");

    const [firstTerminal, answerTerminal] = await Promise.all([first, answer]);
    expect(firstTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(messageTexts(firstTerminal.state).join("\n")).toContain("Here are my answers");
  });

  test("start during an active turn rejects without creating another branch", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "first" });
    await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const second = runner.turn({ type: "start", mode: "agent", prompt: "second" });
    await expect(second).rejects.toThrow("Cannot start a new turn while another turn is active.");

    runner.completeNext("first response");

    const terminal = await first;
    expect(terminal).toMatchObject({ type: "complete", status: "completed" });
    expect(messageTexts(terminal.state)).not.toContain("second");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("queued wake rebases onto latest state and no-ops when no longer sleeping on a poll", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "finish work" });
    await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
      state: { ...createStateMachineState("poll_email_reply"), status: "sleeping" },
    });

    runner.completeNext("done");
    const [firstTerminal, wakeTerminal] = await Promise.all([first, wake]);

    expect(firstTerminal).toBe(wakeTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(wakeTerminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: "Nothing to wake.",
    });
  });

  test("prompts sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "state_machine" && event.currentState === "script_step",
      ),
    );

    const prompt = runner.turn({
      type: "prompt",
      state,
      message: "question during script",
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("question during script");
    runner.completeNext("answer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("answer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
  });

  test("answers sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "state_machine" && event.currentState === "script_step",
      ),
    );

    const answer = runner.turn({
      type: "answer",
      state,
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { choice: "A" },
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("Here are my answers");
    runner.completeNext("answer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("answer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, answerTerminal] = await Promise.all([turn, answer]);
    expect(turnTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("steer prompts sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "state_machine" && event.currentState === "script_step",
      ),
    );

    const steer = runner.turn({
      type: "prompt",
      state,
      message: "steer during script",
      behavior: "steer",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("steer during script");
    runner.completeNext("steer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("steer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, steerTerminal] = await Promise.all([turn, steer]);
    expect(turnTerminal).toBe(steerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("prompts sent during poll checks run immediately and return to sleep when unresolved", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some((event) => event.type === "state_machine" && event.currentState === "poll_reply"),
    );

    const prompt = runner.turn({
      type: "prompt",
      state,
      message: "question during poll",
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2, 100);
    expect(lastUserText(runner.contexts[1]!)).toContain("question during poll");
    runner.completeNext("poll still waiting");

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("steer prompts sent during poll checks run immediately and return to sleep", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some((event) => event.type === "state_machine" && event.currentState === "poll_reply"),
    );

    const steer = runner.turn({
      type: "prompt",
      state,
      message: "steer during poll",
      behavior: "steer",
    });

    await waitFor(() => runner.contexts.length >= 2, 100);
    expect(lastUserText(runner.contexts[1]!)).toContain("steer during poll");
    runner.completeNext("poll still waiting after steer");

    const [turnTerminal, steerTerminal] = await Promise.all([turn, steer]);
    expect(turnTerminal).toBe(steerTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("queued wake behind state-machine work rebases onto sleeping poll state", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: immediateUnresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
      state: { ...createStateMachineState("poll_email_reply"), status: "sleeping" },
    });

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(turnTerminal.state.stateMachine?.currentState).toBe("poll_reply");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("additional prompts during a mid-poll answer join the active parent agent", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some((event) => event.type === "state_machine" && event.currentState === "poll_reply"),
    );

    const firstPrompt = runner.turn({
      type: "prompt",
      state,
      message: "first question during poll",
      behavior: "follow_up",
    });
    await waitFor(() => runner.contexts.length >= 2);

    const secondPrompt = runner.turn({
      type: "prompt",
      state,
      message: "second question during poll",
      behavior: "follow_up",
    });

    runner.completeNext("first poll answer");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain("second question during poll");
    runner.completeNext("second poll answer");

    const [turnTerminal, firstTerminal, secondTerminal] = await Promise.all([
      turn,
      firstPrompt,
      secondPrompt,
    ]);
    expect(turnTerminal).toBe(firstTerminal);
    expect(firstTerminal).toBe(secondTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("resolved polls enqueue state-machine continuation after the mid-poll agent answer", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: resolvedPollDefinition(),
      prompt: "run resolved poll flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some((event) => event.type === "state_machine" && event.currentState === "poll_reply"),
    );

    const prompt = runner.turn({
      type: "prompt",
      state,
      message: "question during resolving poll",
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("question during resolving poll");
    await delay(75);
    runner.completeNext("agent saw user before continuation");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "poll_reply" finished');
    expect(contextText(runner.contexts[2]!)).toContain("agent saw user before continuation");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("sleeping follow-up failure emits system error and resolves to sleep", async () => {
    const { runner, events } = createStreamingRunner();
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };

    const turn = runner.turn({
      type: "prompt",
      state: sleeping,
      message: "anything new?",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("", { error: "model failed" });

    const terminal = await turn;
    expect(terminal.type).toBe("sleep");
    expect(terminal.state.status).toBe("sleeping");
    expect(events).toContainEqual({
      type: "system",
      level: "error",
      message: "model failed",
    });
    expect(
      events.filter((event) => event.type === "complete" && event.status === "failed"),
    ).toEqual([]);
  });

  test("failed active turns emit one failed terminal and drop queued commands", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({ type: "start", mode: "agent", prompt: "start" });
    await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
      state: { ...createStateMachineState("poll_email_reply"), status: "sleeping" },
    });

    runner.completeNext("", { error: "model failed" });

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "failed" });
    expect(turnTerminal.type === "complete" ? turnTerminal.result : "").not.toBe(
      "Nothing to wake.",
    );
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("interrupt drops queued work and emits one interrupted terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const first = runner.turn({ type: "start", mode: "agent", prompt: "start" });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const followUp = runner.turn({
      type: "prompt",
      state,
      message: "queued",
      behavior: "follow_up",
    });
    runner.interrupt({ type: "interrupt", state });
    runner.completeNext("", { error: "aborted" });

    const [firstTerminal, followUpTerminal] = await Promise.all([first, followUp]);
    expect(firstTerminal).toBe(followUpTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(firstTerminal.type).toBe("interrupted");
    expect(messageTexts(firstTerminal.state)).not.toContain("queued");
  });

  test("dispose drops queued work without starting another command", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({ type: "start", mode: "agent", prompt: "start" });
    await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
      state: { ...createStateMachineState("poll_email_reply"), status: "sleeping" },
    });
    await delay(0);
    await runner.dispose();

    runner.completeNext("done");

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(turnTerminal.type === "complete" ? turnTerminal.result : "").not.toBe(
      "Nothing to wake.",
    );
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("answers can follow up the active child agent directly", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: childAgentDefinition(),
      prompt: "run child flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "child_agent" },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "state_machine" && event.currentState === "child_agent",
      ),
    );
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      state,
      questions: [{ question: "Child question", options: [{ label: "A" }] }],
      answers: { choice: "A" },
      behavior: "follow_up",
    });

    runner.completeNext("child first response");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain("Here are my answers");
    runner.completeNext("child answer response");
    await waitFor(() => runner.contexts.length >= 4);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, answerTerminal] = await Promise.all([turn, answer]);
    expect(turnTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("prompts during active child agent work queue for the parent", async () => {
    const { runner, events } = createStreamingRunner();
    const turn = runner.turn({
      type: "start",
      mode: childAgentDefinition(),
      prompt: "run child flow",
    });
    const state = await waitForStartedState(events);
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "child_agent" },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "state_machine" && event.currentState === "child_agent",
      ),
    );
    await waitFor(() => runner.pendingStreams.length === 1);

    const prompt = runner.turn({
      type: "prompt",
      state,
      message: "parent should handle this",
      behavior: "follow_up",
    });

    runner.completeNext("child response");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[1]!)).not.toContain("parent should handle this");
    expect(lastUserText(runner.contexts[2]!)).toContain("parent should handle this");
    runner.completeNext("parent response");

    await waitFor(() => runner.contexts.length >= 4);
    expect(lastUserText(runner.contexts[3]!)).toContain('The state "child_agent" finished');
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });
});

function createStreamingRunner(): { runner: StreamingTurnRunner; events: TurnEvent[] } {
  const runner = new StreamingTurnRunner();
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return { runner, events };
}

async function waitForStartedState(events: TurnEvent[]): Promise<TurnState> {
  await waitFor(() => events.some((event) => event.type === "session_started"));
  const event = events.find((item) => item.type === "session_started");
  if (!event || event.type !== "session_started") throw new Error("Missing session_started event");
  return event.state;
}

function terminalEvents(events: TurnEvent[]): TurnTerminalEvent[] {
  return events.filter(
    (event): event is TurnTerminalEvent =>
      event.type === "ask" ||
      event.type === "complete" ||
      event.type === "interrupted" ||
      event.type === "sleep",
  );
}

function messageTexts(state: TurnState): string[] {
  return state.agent.messages.flatMap((message) => {
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    );
  });
}

function contextText(context: Context): string {
  return context.messages
    .map((message) => {
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join("\n");
    })
    .join("\n");
}

function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  return contextText({ ...context, messages: [user] });
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createAssistantMessage(
  text: string,
  errorMessage?: string,
  extraContent: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...extraContent],
    api: "unknown",
    provider: "unknown",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: extraContent.some((part) => part.type === "toolCall")
      ? "toolUse"
      : errorMessage
        ? "error"
        : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function scriptThenTerminalDefinition(): StateMachineDefinition {
  return {
    name: "script_flow",
    prompt: "Use for script test.",
    states: [
      {
        kind: "script",
        name: "script_step",
        command: "sleep 0.05; printf '{\"scriptDone\":true}'",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function unresolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "poll_flow",
    prompt: "Use for poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        poll: { kind: "script", command: "sleep 2; printf '{}'" },
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function resolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "resolved_poll_flow",
    prompt: "Use for resolved poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        poll: { kind: "script", command: 'sleep 0.05; printf \'{"reply":"yes"}\'' },
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function immediateUnresolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "immediate_poll_flow",
    prompt: "Use for immediate poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        poll: { kind: "script", command: "printf '{}'" },
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function childAgentDefinition(): StateMachineDefinition {
  return {
    name: "child_flow",
    prompt: "Use for child test.",
    states: [
      { kind: "agent", name: "child_agent", prompt: "Ask the child question." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}
