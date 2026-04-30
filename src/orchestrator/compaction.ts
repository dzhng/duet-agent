import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummary,
  shouldCompact,
} from "@mariozechner/pi-coding-agent";

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface ContextCompactionOptions {
  model: Model<any>;
  settings?: Partial<CompactionSettings>;
  apiKey?: string;
  headers?: Record<string, string>;
  customInstructions?: string;
}

/**
 * Adapter around pi coding-agent's compaction primitives for agent-core's
 * transformContext hook.
 */
export function createCompactionTransform(options: ContextCompactionOptions) {
  const settings: CompactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...options.settings,
  };

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    const contextWindow = options.model.contextWindow;
    if (!contextWindow) return messages;

    const contextTokens = estimateMessagesTokens(messages);
    if (!shouldCompact(contextTokens, contextWindow, settings)) {
      return messages;
    }

    const existingSummary = messages.find((message) => message.role === "compactionSummary") as
      | { role: "compactionSummary"; summary: string }
      | undefined;
    const compactableMessages = existingSummary
      ? messages.filter((message) => message !== existingSummary)
      : messages;
    const splitIndex = findRecentWindowStart(compactableMessages, settings.keepRecentTokens);
    if (splitIndex <= 0) return messages;

    const messagesToSummarize = compactableMessages.slice(0, splitIndex);
    const messagesToKeep = compactableMessages.slice(splitIndex);
    const summary = await generateSummary(
      messagesToSummarize,
      options.model,
      settings.reserveTokens,
      options.apiKey ?? "",
      options.headers,
      signal,
      options.customInstructions,
      existingSummary?.summary,
    );

    return [
      {
        role: "compactionSummary",
        summary,
        tokensBefore: contextTokens,
        timestamp: Date.now(),
      } as AgentMessage,
      ...messagesToKeep,
    ];
  };
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function findRecentWindowStart(messages: AgentMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  let index = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateTokens(messages[i]);
    if (tokens > keepRecentTokens) break;
    index = i;
  }

  while (index < messages.length && messages[index]?.role === "toolResult") {
    index++;
  }

  return index;
}
