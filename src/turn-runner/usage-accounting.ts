import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelUsageEntry, TurnTokenUsage } from "../types/protocol.js";

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
  usage: TurnTokenUsage | undefined,
): ModelUsageEntry[] {
  const next: ModelUsageEntry[] = (list ?? []).map((entry) => ({
    model: entry.model,
    usage: cloneUsage(entry.usage),
  }));
  if (!usage) return next;
  const existing = next.find((entry) => entry.model === model);
  if (existing) {
    existing.usage = addUsage(existing.usage, usage)!;
  } else {
    next.push({ model, usage: cloneUsage(usage) });
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
