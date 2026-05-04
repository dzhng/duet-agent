import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Harness } from "../src/harness/harness.js";
import type { HarnessEvent } from "../src/types/protocol.js";
import { createHarness } from "./helpers/harness-protocol.js";

class EventHarness extends Harness {
  emitAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event);
  }
}

function createEventHarness(): { harness: EventHarness; events: HarnessEvent[] } {
  const harness = new EventHarness({
    harnessModel: "anthropic:claude-opus-4-6",
    skillDiscovery: { includeDefaults: false },
  });
  const events: HarnessEvent[] = [];
  harness.subscribe((event) => events.push(event));
  return { harness, events };
}

describe("Harness event emission", () => {
  test("emits ready, session_started, and the terminal event for a turn", async () => {
    const { harness, events } = createHarness();

    const terminal = await harness.turn({
      type: "start",
      mode: "agent",
      prompt: "Summarize this file.",
    });

    expect(events.map((event) => event.type)).toEqual(["ready", "session_started", "complete"]);
    expect(events.at(-1)).toBe(terminal);
  });

  test("translates complete assistant text and reasoning blocks into step events", () => {
    const { harness, events } = createEventHarness();

    harness.emitAgentEventForTest({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Final answer",
        partial: { role: "assistant" } as never,
      },
    });
    harness.emitAgentEventForTest({
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
    const { harness, events } = createEventHarness();

    harness.emitAgentEventForTest({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    harness.emitAgentEventForTest({
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
