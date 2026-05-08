import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { TurnTokenUsage } from "../types/protocol.js";

export function addUsage(
  current: TurnTokenUsage | undefined,
  usage: TurnTokenUsage | Usage | undefined,
): TurnTokenUsage | undefined {
  if (!usage) return current;
  const normalized = normalizeUsage(usage);
  const next = current ?? { inputTokens: 0, outputTokens: 0 };
  next.inputTokens += normalized.inputTokens;
  next.outputTokens += normalized.outputTokens;
  if (normalized.cachedInputTokens !== undefined) {
    next.cachedInputTokens = (next.cachedInputTokens ?? 0) + normalized.cachedInputTokens;
  }
  if (normalized.costUsd !== undefined) {
    next.costUsd = (next.costUsd ?? 0) + normalized.costUsd;
  }
  return next;
}

export function normalizeUsage(usage: TurnTokenUsage | Usage): TurnTokenUsage {
  if ("inputTokens" in usage) return usage;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    costUsd: usage.cost.total,
  };
}

export function usageFromMessages(messages: readonly AgentMessage[]): TurnTokenUsage | undefined {
  const usage: TurnTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let hasUsage = false;

  for (const message of messages) {
    if (!isAssistantMessageWithUsage(message)) continue;
    hasUsage = true;
    usage.inputTokens += message.usage.input;
    usage.outputTokens += message.usage.output;
    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + message.usage.cacheRead;
    usage.costUsd = (usage.costUsd ?? 0) + message.usage.cost.total;
  }

  return hasUsage ? usage : undefined;
}

function isAssistantMessageWithUsage(
  message: AgentMessage,
): message is AgentMessage & { usage: Usage } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "usage" in message &&
    typeof message.usage === "object" &&
    message.usage !== null
  );
}
