import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnTokenUsage } from "../types/protocol.js";

export function addUsage(
  current: TurnTokenUsage | undefined,
  usage: TurnTokenUsage | undefined,
): TurnTokenUsage | undefined {
  if (!usage) return current;
  const next = current ?? emptyUsage();
  next.input += usage.input;
  next.output += usage.output;
  next.cacheRead += usage.cacheRead;
  next.cacheWrite += usage.cacheWrite;
  next.totalTokens += usage.totalTokens;
  next.cost.input += usage.cost.input;
  next.cost.output += usage.cost.output;
  next.cost.cacheRead += usage.cost.cacheRead;
  next.cost.cacheWrite += usage.cost.cacheWrite;
  next.cost.total += usage.cost.total;
  return next;
}

function emptyUsage(): TurnTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function usageFromMessages(messages: readonly AgentMessage[]): TurnTokenUsage | undefined {
  const usage = emptyUsage();
  let hasUsage = false;

  for (const message of messages) {
    if (!isAssistantMessageWithUsage(message)) continue;
    hasUsage = true;
    addUsage(usage, message.usage);
  }

  return hasUsage ? usage : undefined;
}

function isAssistantMessageWithUsage(
  message: AgentMessage,
): message is AgentMessage & { usage: TurnTokenUsage } {
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
