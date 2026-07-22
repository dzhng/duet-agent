import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnStepEvent } from "../types/protocol.js";

/**
 * Build a translator from pi agent events to turn step events.
 *
 * The translator is stateful: pi's `tool_execution_end` does not carry the
 * tool arguments, but the canonical `tool_call` step is self-contained (it
 * echoes the call's `input`, mirroring how the canonical `text` step carries
 * the full text after `text_delta`). Each call's input is remembered from
 * `tool_execution_start` until its end event arrives. Tool call ids are
 * unique across the parent and state agents, so one translator per runner is
 * enough.
 */
export function createAgentEventTranslator(): (event: AgentEvent) => TurnStepEvent[] {
  const inputByToolCallId = new Map<string, Record<string, any> | undefined>();

  return (event) => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_delta":
            return [{ type: "step", step: { type: "text_delta", delta: update.delta } }];
          case "thinking_delta":
            return [{ type: "step", step: { type: "reasoning_delta", delta: update.delta } }];
          case "text_end":
            return [{ type: "step", step: { type: "text", text: update.content } }];
          case "thinking_end":
            return [{ type: "step", step: { type: "reasoning", text: update.content } }];
        }
        return [];
      }
      case "tool_execution_start":
        inputByToolCallId.set(event.toolCallId, event.args);
        return [
          {
            type: "step",
            step: {
              type: "tool_call_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input: event.args,
            },
          },
        ];
      case "tool_execution_end": {
        const input = inputByToolCallId.get(event.toolCallId);
        inputByToolCallId.delete(event.toolCallId);
        return [
          {
            type: "step",
            step: {
              type: "tool_call",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input,
              isError: event.isError,
              output: event.result?.content,
              details: event.result?.details,
            },
          },
        ];
      }
      default:
        return [];
    }
  };
}

export function agentMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/** Whether an agent event has crossed the transport-fallback replay boundary. */
export function isExternallyVisibleAgentEvent(event: AgentEvent): boolean {
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return (
    ((update.type === "text_delta" || update.type === "thinking_delta") &&
      update.delta.length > 0) ||
    ((update.type === "text_end" || update.type === "thinking_end") && update.content.length > 0)
  );
}
