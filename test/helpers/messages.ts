import type { AssistantMessage } from "@mariozechner/pi-ai";

export function createAssistantMessage(input: {
  text?: string;
  errorMessage?: string;
  extraContent?: AssistantMessage["content"];
  stopReason?: AssistantMessage["stopReason"];
  timestamp?: number;
}): AssistantMessage {
  const content: AssistantMessage["content"] = [
    ...(input.text !== undefined ? [{ type: "text" as const, text: input.text }] : []),
    ...(input.extraContent ?? []),
  ];
  return {
    role: "assistant",
    content,
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
    stopReason:
      input.stopReason ??
      (input.extraContent?.some((part) => part.type === "toolCall")
        ? "toolUse"
        : input.errorMessage
          ? "error"
          : "stop"),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: input.timestamp ?? Date.now(),
  };
}
