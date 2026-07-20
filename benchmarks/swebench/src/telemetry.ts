import type {
  ModelUsageEntry,
  TurnEvent,
  TurnTerminalEvent,
  TurnTokenUsage,
} from "../../../src/types/protocol.js";

export type AdvisorCallOutcome = "success" | "rate_limited" | "unavailable" | "failed";

/** Structurally parsed request-window metadata emitted by newer advisor results. */
export interface AdvisorContextObservation {
  /** Advisor model's advertised input-plus-output context window. */
  contextWindowTokens: number;
  /** Output allowance reserved before fitting executor context. */
  reservedOutputTokens: number;
  /** Maximum executor-context estimate after system and output reservations. */
  inputLimitTokens: number;
  /** Estimated total advisor input, including the shared per-image charge. */
  estimatedInputTokens: number;
  /** Executor messages retained in the advisor request. */
  includedMessages: number;
  /** Oldest executor messages omitted at whole-message boundaries. */
  omittedMessages: number;
  /** True when the real advisor model window forced message omission. */
  truncated: boolean;
  /** Executor images forwarded as multimodal request parts. */
  attachedImages: number;
}

/** One advisor attempt located in the parent agent's canonical step sequence. */
export interface AdvisorCallObservation {
  /** One-based index after streaming deltas and transient tool starts are removed. */
  step: number;
  outcome: AdvisorCallOutcome;
  /** Concrete provider model, available only after a successful consultation. */
  model?: string;
  /** Distinguishes old/missing metadata from malformed metadata and validated observations. */
  contextStatus: "valid" | "missing" | "malformed";
  /** Present only when every context-fidelity field parsed with its required primitive type. */
  context?: AdvisorContextObservation;
  /**
   * Relative position when an explicit repository `edit` or `write` is observable.
   * `unknown` does not prove that no mutation occurred because shell commands are opaque.
   */
  relativeToFirstExplicitRepositoryMutation: "before" | "after" | "unknown";
}

/** Advisor tool outcomes observable from generic tool-result details. */
export interface AdvisorCallTelemetry {
  /** All observed `ask_advisor` tool completions, including non-consulting outcomes. */
  total: number;
  /** Calls that returned advice from a named concrete model. */
  success: number;
  /** Calls rejected by the product cadence gate. */
  rateLimited: number;
  /** Calls made when no usable advisor route was available. */
  unavailable: number;
  /** Tool errors or malformed results that did not return usable advice. */
  failed: number;
  /** Successful advisor calls grouped by the concrete model reported by the tool. */
  successByModel: Record<string, number>;
  /**
   * First successful explicit repository `edit` or `write`, or null when none is observable.
   * Shell commands are deliberately not guessed to be read-only or mutating.
   */
  firstExplicitRepositoryMutationStep: number | null;
  /** Ordered call-level evidence used for attribution and context-fidelity admission. */
  attempts: AdvisorCallObservation[];
}

/** Re-derivable benchmark metrics computed only from the raw RPC event stream. */
export interface RolloutTelemetry {
  /** Version of the persisted `telemetry.json` contract. */
  schemaVersion: 2;
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
    failed: 0,
    successByModel: {},
    firstExplicitRepositoryMutationStep: null,
    attempts: [],
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
    if (
      event.step.type === "text_delta" ||
      event.step.type === "reasoning_delta" ||
      event.step.type === "tool_call_start"
    ) {
      continue;
    }
    steps += 1;
    if (
      advisorCalls.firstExplicitRepositoryMutationStep === null &&
      event.step.type === "tool_call" &&
      !event.step.isError &&
      isExplicitRepositoryMutation(event.step.toolName, event.step.input)
    ) {
      advisorCalls.firstExplicitRepositoryMutationStep = steps;
    }
    if (event.step.type !== "tool_call" || event.step.toolName !== "ask_advisor") continue;

    const details = asAdvisorDetails(event.step.details);
    advisorCalls.total += 1;
    let outcome: AdvisorCallOutcome;
    if (details?.rateLimited) {
      outcome = "rate_limited";
      advisorCalls.rateLimited += 1;
    } else if (details?.unavailable) {
      outcome = "unavailable";
      advisorCalls.unavailable += 1;
    } else if (event.step.isError || !details?.model) {
      outcome = "failed";
      advisorCalls.failed += 1;
    } else {
      outcome = "success";
      advisorCalls.success += 1;
      increment(advisorCalls.successByModel, details.model);
    }
    advisorCalls.attempts.push({
      step: steps,
      outcome,
      ...(details?.model ? { model: details.model } : {}),
      contextStatus: details?.contextStatus ?? "missing",
      ...(details?.context ? { context: details.context } : {}),
      relativeToFirstExplicitRepositoryMutation: "unknown",
    });
  }

  for (const attempt of advisorCalls.attempts) {
    attempt.relativeToFirstExplicitRepositoryMutation =
      advisorCalls.firstExplicitRepositoryMutationStep === null
        ? "unknown"
        : attempt.step < advisorCalls.firstExplicitRepositoryMutationStep
          ? "before"
          : "after";
  }

  const usage = latestUsage?.turnUsage ?? emptyUsage();
  const usageByModel = latestUsage?.usageByModel ?? [];
  const costUsdByModel: Record<string, number> = {};
  for (const entry of usageByModel) increment(costUsdByModel, entry.model, entry.usage.cost.total);
  return {
    schemaVersion: 2,
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
  contextStatus: "valid" | "missing" | "malformed";
  context?: AdvisorContextObservation;
}

function asAdvisorDetails(value: unknown): AdvisorDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  if (details.type !== "ask_advisor") return undefined;
  const context = asAdvisorContext(details.context);
  return {
    type: "ask_advisor",
    ...(typeof details.model === "string" ? { model: details.model } : {}),
    ...(details.rateLimited === true ? { rateLimited: true } : {}),
    ...(details.unavailable === true ? { unavailable: true } : {}),
    contextStatus: details.context === undefined ? "missing" : context ? "valid" : "malformed",
    ...(context ? { context } : {}),
  };
}

function asAdvisorContext(value: unknown): AdvisorContextObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const context = value as Record<string, unknown>;
  const contextWindowTokens = positiveInteger(context.contextWindowTokens);
  const reservedOutputTokens = nonnegativeInteger(context.reservedOutputTokens);
  const inputLimitTokens = positiveInteger(context.inputLimitTokens);
  const estimatedInputTokens = positiveInteger(context.estimatedInputTokens);
  const includedMessages = nonnegativeInteger(context.includedMessages);
  const omittedMessages = nonnegativeInteger(context.omittedMessages);
  const attachedImages = nonnegativeInteger(context.attachedImages);
  if (
    contextWindowTokens === undefined ||
    reservedOutputTokens === undefined ||
    inputLimitTokens === undefined ||
    estimatedInputTokens === undefined ||
    includedMessages === undefined ||
    omittedMessages === undefined ||
    attachedImages === undefined ||
    typeof context.truncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    contextWindowTokens,
    reservedOutputTokens,
    inputLimitTokens,
    estimatedInputTokens,
    includedMessages,
    omittedMessages,
    truncated: context.truncated,
    attachedImages,
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isExplicitRepositoryMutation(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (toolName !== "edit" && toolName !== "write") return false;
  const path = input?.path;
  if (typeof path !== "string") return false;
  return !path.startsWith("/") || path === "/testbed" || path.startsWith("/testbed/");
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
