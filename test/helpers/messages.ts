import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
  const usage = {
    ...EMPTY_USAGE,
    ...input.usage,
    cost: { ...EMPTY_USAGE.cost, ...input.usage?.cost },
  };
  usage.totalTokens = input.usage?.totalTokens ?? usage.input + usage.output;
  return {
    role: "assistant",
    content,
    api: "unknown",
    provider: "unknown",
    model: "test",
    usage,
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
