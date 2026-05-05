import { describe, expect, test } from "bun:test";
import { Agent } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
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

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createAssistantMessage(text: string, errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    stopReason: errorMessage ? "error" : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}
