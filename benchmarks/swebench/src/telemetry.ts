import type {
  ModelUsageEntry,
  TurnEvent,
  TurnTerminalEvent,
  TurnTokenUsage,
} from "../../../src/types/protocol.js";

/** Advisor tool outcomes observable from generic tool-result details. */
export interface AdvisorCallTelemetry {
  total: number;
  success: number;
  rateLimited: number;
  unavailable: number;
  /** Successful advisor calls grouped by the concrete model reported by the tool. */
  successByModel: Record<string, number>;
}

/** Re-derivable benchmark metrics computed only from the raw RPC event stream. */
export interface RolloutTelemetry {
  costUsdTotal: number;
  /** Provider spend grouped by concrete model id, never inferred as a runtime role. */
  costUsdByModel: Record<string, number>;
  tokens: Pick<TurnTokenUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
  /** Latest cumulative per-model ledger retained for exact downstream analysis. */
  usageByModel: ModelUsageEntry[];
  advisorCalls: AdvisorCallTelemetry;
  routerSwitches: Record<string, number>;
  /** Canonical parent step events, excluding streaming deltas and subagent-origin steps. */
  steps: number;
  terminalStatus:
    | "completed"
    | "failed"
    | "cancelled"
    | "ask"
    | "interrupted"
    | "sleep"
    | "missing";
}

/** Derive all campaign telemetry from a raw, append-only RPC event ledger. */
export function deriveTelemetry(events: readonly TurnEvent[]): RolloutTelemetry {
  let latestUsage: Pick<TurnTokenUsageHolder, "turnUsage" | "usageByModel"> | undefined;
  let terminal: TurnTerminalEvent | undefined;
  let steps = 0;
  const advisorCalls: AdvisorCallTelemetry = {
    total: 0,
    success: 0,
    rateLimited: 0,
    unavailable: 0,
    successByModel: {},
  };
  const routerSwitches: Record<string, number> = {};

  for (const event of events) {
    const loose = event as TurnEvent & Partial<TurnTokenUsageHolder>;
    if (loose.turnUsage && Array.isArray(loose.usageByModel)) {
      latestUsage = { turnUsage: loose.turnUsage, usageByModel: loose.usageByModel };
    }

    if (isTerminal(event)) terminal ??= event;

    if (event.type === "router_switch") {
      increment(routerSwitches, `${event.fromModel}→${event.toModel}`);
    }

    if (event.type !== "step" || event.origin) continue;
    if (event.step.type !== "text_delta" && event.step.type !== "reasoning_delta") steps += 1;
    if (event.step.type !== "tool_call" || event.step.toolName !== "ask_advisor") continue;

    const details = asAdvisorDetails(event.step.details);
    if (!details) continue;
    advisorCalls.total += 1;
    if (details.rateLimited) {
      advisorCalls.rateLimited += 1;
    } else if (details.unavailable || event.step.isError) {
      advisorCalls.unavailable += 1;
    } else {
      advisorCalls.success += 1;
      if (details.model) increment(advisorCalls.successByModel, details.model);
    }
  }

  const usage = latestUsage?.turnUsage ?? emptyUsage();
  const usageByModel = latestUsage?.usageByModel ?? [];
  const costUsdByModel: Record<string, number> = {};
  for (const entry of usageByModel) increment(costUsdByModel, entry.model, entry.usage.cost.total);
  return {
    costUsdTotal: usage.cost.total,
    costUsdByModel,
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    },
    usageByModel,
    advisorCalls,
    routerSwitches,
    steps,
    terminalStatus: terminalStatus(terminal),
  };
}

interface TurnTokenUsageHolder {
  turnUsage: TurnTokenUsage;
  usageByModel: ModelUsageEntry[];
}

interface AdvisorDetails {
  type: "ask_advisor";
  model?: string;
  rateLimited?: boolean;
  unavailable?: boolean;
}

function asAdvisorDetails(value: unknown): AdvisorDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  if (details.type !== "ask_advisor") return undefined;
  return {
    type: "ask_advisor",
    ...(typeof details.model === "string" ? { model: details.model } : {}),
    ...(details.rateLimited === true ? { rateLimited: true } : {}),
    ...(details.unavailable === true ? { unavailable: true } : {}),
  };
}

function isTerminal(event: TurnEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function terminalStatus(
  terminal: TurnTerminalEvent | undefined,
): RolloutTelemetry["terminalStatus"] {
  if (!terminal) return "missing";
  if (terminal.type === "complete") return terminal.status;
  return terminal.type;
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
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
