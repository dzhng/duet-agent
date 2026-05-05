import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createTurnRunner } from "./helpers/turn-runner-protocol.js";

class EventTurnRunner extends TurnRunner {
  emitAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event);
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

describe("TurnRunner event emission", () => {
  test("emits ready, session_started, and the terminal event for a turn", async () => {
    const { runner, events } = createTurnRunner();

    const terminal = await runner.turn({
      type: "start",
      mode: "agent",
      prompt: "Summarize this file.",
    });

    expect(events.map((event) => event.type)).toEqual(["ready", "session_started", "complete"]);
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
});
