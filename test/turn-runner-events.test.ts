import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { waitFor } from "./helpers/async.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { createTurnRunner, startTurn } from "./helpers/turn-runner-protocol.js";

class EventTurnRunner extends TurnRunner {
  emitAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event);
  }
}

class ToolEventTurnRunner extends TurnRunner {
  readonly pendingStreams: ReturnType<typeof createAssistantMessageEventStream>[] = [];

  protected override createAgent(
    input: AgentWorkerInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      this.pendingStreams.push(stream);
      return stream;
    };
    return agent;
  }

  completeNextToolCall(name: string, args: Record<string, unknown>): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "toolUse",
      message: createAssistantMessage({
        extraContent: [{ type: "toolCall", id: `tool_${Date.now()}`, name, arguments: args }],
      }),
    });
  }

  completeNext(text: string): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "stop",
      message: createAssistantMessage({ text }),
    });
  }
}

function createEventTurnRunner(): { runner: EventTurnRunner; events: TurnEvent[] } {
  const runner = new EventTurnRunner({
    model: "anthropic:claude-opus-4-7",
    skillDiscovery: { includeDefaults: false },
  });
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return { runner, events };
}

function createToolEventTurnRunner(): { runner: ToolEventTurnRunner; events: TurnEvent[] } {
  const runner = new ToolEventTurnRunner({
    model: "anthropic:claude-opus-4-7",
    skillDiscovery: { includeDefaults: false },
  });
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return { runner, events };
}

describe("TurnRunner event emission", () => {
  test("emits turn_started and the terminal event for a turn", async () => {
    const { runner, events } = createTurnRunner();

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "Summarize this file." })
    ).turn;

    expect(events.map((event) => event.type)).toEqual(["turn_started", "complete"]);
    expect(events.at(-1)).toBe(terminal);
  });

  test("translates complete assistant text and reasoning blocks into step events", () => {
    const { runner, events } = createEventTurnRunner();

    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Final answer",
        partial: { role: "assistant" } as never,
      },
    });
    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Reasoning summary",
        partial: { role: "assistant" } as never,
      },
    });

    expect(events).toEqual([
      { type: "step", step: { type: "text", text: "Final answer" } },
      { type: "step", step: { type: "reasoning", text: "Reasoning summary" } },
    ]);
  });

  test("translates streaming assistant text and reasoning deltas into step events", () => {
    const { runner, events } = createEventTurnRunner();

    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Partial ",
        partial: { role: "assistant" } as never,
      },
    });
    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "answer",
        partial: { role: "assistant" } as never,
      },
    });
    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Partial answer",
        partial: { role: "assistant" } as never,
      },
    });
    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "Reason",
        partial: { role: "assistant" } as never,
      },
    });
    runner.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 1,
        content: "Reasoning summary",
        partial: { role: "assistant" } as never,
      },
    });

    expect(events).toEqual([
      { type: "step", step: { type: "text_delta", delta: "Partial " } },
      { type: "step", step: { type: "text_delta", delta: "answer" } },
      { type: "step", step: { type: "text", text: "Partial answer" } },
      { type: "step", step: { type: "reasoning_delta", delta: "Reason" } },
      { type: "step", step: { type: "reasoning", text: "Reasoning summary" } },
    ]);
  });

  test("translates tool execution lifecycle into tool_call step events", () => {
    const { runner, events } = createEventTurnRunner();

    runner.emitAgentEventForTest({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    runner.emitAgentEventForTest({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: undefined,
      isError: false,
    });

    expect(events).toEqual([
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "read",
          toolCallId: "tool-1",
          status: "running",
          input: { path: "README.md" },
        },
      },
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "read",
          toolCallId: "tool-1",
          status: "completed",
        },
      },
    ]);
  });

  test("emits todos events when todo_write runs", async () => {
    const { runner, events } = createToolEventTurnRunner();
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "Track work with todos." });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("todo_write", {
      merge: false,
      todos: [{ id: "test", content: "Run tests", status: "in_progress" }],
    });
    await waitFor(() => events.some((event) => event.type === "todos"));
    runner.completeNext("Done");
    await turn;

    expect(events).toContainEqual({
      type: "todos",
      todos: [{ id: "test", content: "Run tests", status: "in_progress" }],
    });
  });
});
