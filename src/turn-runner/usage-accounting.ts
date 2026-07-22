import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import type { LanguageModelUsage } from "ai";
import { usageForTransport } from "../connected-providers/billing.js";
import { isConnectedProviderId } from "../connected-providers/store.js";
import type { TransportName } from "../model-resolution/catalog.js";
import type { ModelUsageEntry, TurnTokenUsage } from "../types/protocol.js";

/** Convert AI SDK token fields into the priced usage shape owned by pi-ai. */
export function usageFromAiSdk<TApi extends Api>(
  usage: LanguageModelUsage,
  model: Model<TApi>,
  options: { planCovered?: boolean } = {},
): Usage {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const input =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const output = usage.outputTokens ?? 0;
  const normalized: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (!options.planCovered) calculateCost(model, normalized);
  return normalized;
}

/**
 * Returns a new `TurnTokenUsage` equal to `a + b`, treating either operand
 * being `undefined` as the empty usage.
 *
 * Pure function: callers must use the return value. Earlier in-place semantics
 * led to call sites that discarded the return and relied on the accumulator
 * being mutated through a shared reference, which made the contract subtle.
 */
export function addUsage(
  a: TurnTokenUsage | undefined,
  b: TurnTokenUsage | undefined,
): TurnTokenUsage | undefined {
  if (!a && !b) return undefined;
  if (!a) return cloneUsage(b!);
  if (!b) return cloneUsage(a);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/**
 * Returns a new per-model usage breakdown equal to `list` with `usage`
 * folded into the entry for `model` (summed via {@link addUsage}, appended
 * when the model is not present yet). Pure: never mutates `list`. A falsy
 * `usage` returns a cloned copy of `list` unchanged, so the invariant
 * `sum(result[].usage.cost.total) === addUsage(turnUsage, usage).cost.total`
 * holds whenever the same `usage` is also folded into the turn aggregate.
 */
export function addUsageByModel(
  list: readonly ModelUsageEntry[] | undefined,
  model: string,
  provider: TransportName,
  usage: TurnTokenUsage | undefined,
): ModelUsageEntry[] {
  const next: ModelUsageEntry[] = (list ?? []).map((entry) => ({
    model: entry.model,
    transport: { ...entry.transport },
    usage: cloneUsage(entry.usage),
  }));
  if (!usage) return next;
  const accountedUsage = usageForTransport(usage, provider);
  const existing = next.find(
    (entry) => entry.model === model && entry.transport.provider === provider,
  );
  if (existing) {
    existing.usage = addUsage(existing.usage, accountedUsage)!;
  } else {
    next.push({
      model,
      transport: {
        provider,
        billing: isConnectedProviderId(provider) ? "plan-covered" : "metered",
      },
      usage: cloneUsage(accountedUsage),
    });
  }
  return next;
}

function cloneUsage(usage: TurnTokenUsage): TurnTokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

/**
 * Sums `Usage` across every assistant message that carries one. Returns
 * `undefined` when no assistant message contributed, so callers can
 * distinguish "no usage yet" from "zero usage."
 *
 * pi-ai populates `usage` per assistant LLM call; there is no aggregate
 * end-of-turn signal from pi, so summing per-message is the canonical
 * total-usage path for a turn.
 */
export function usageFromMessages(messages: readonly AgentMessage[]): TurnTokenUsage | undefined {
  let usage: TurnTokenUsage | undefined;
  for (const message of messages) {
    if (!isAssistantMessageWithUsage(message)) continue;
    usage = addUsage(usage, message.usage);
  }
  return usage;
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
