import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";

export function createAssistantMessage(input: {
  text?: string;
  errorMessage?: string;
  extraContent?: AssistantMessage["content"];
  stopReason?: AssistantMessage["stopReason"];
  timestamp?: number;
  usage?: Partial<Usage>;
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
    usage: createUsage(input.usage),
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

export function createUsage(input?: Partial<Usage>): Usage {
  return {
    input: input?.input ?? 0,
    output: input?.output ?? 0,
    cacheRead: input?.cacheRead ?? 0,
    cacheWrite: input?.cacheWrite ?? 0,
    totalTokens: input?.totalTokens ?? 0,
    cost: {
      input: input?.cost?.input ?? 0,
      output: input?.cost?.output ?? 0,
      cacheRead: input?.cost?.cacheRead ?? 0,
      cacheWrite: input?.cost?.cacheWrite ?? 0,
      total: input?.cost?.total ?? 0,
    },
  };
}
