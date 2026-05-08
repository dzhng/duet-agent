import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnEvent } from "../types/protocol.js";

export function agentEventToTurnEvents(event: AgentEvent): TurnEvent[] {
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
      return [
        {
          type: "step",
          step: {
            type: "tool_call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            status: "running",
            input: event.args,
          },
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "step",
          step: {
            type: "tool_call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            status: event.isError ? "error" : "completed",
            output: event.result?.content,
          },
        },
      ];
    default:
      return [];
  }
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
