import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
import {
  applyEvictionHorizon,
  calculateWireBytes,
  calculateWireTokens,
  IMAGE_WIRE_TOKEN_ESTIMATE,
  findEvictionHorizon,
  WIRE_BYTE_TARGET,
  WIRE_BYTE_TRIGGER,
} from "../turn-runner/wire-shaping.js";
import type { WireGuardHorizon } from "../types/protocol.js";
import type { MemoryContextCache } from "./store.js";
import type { MemorySession } from "./session.js";
import {
  appendObservation,
  bumpLastUsed,
  readSessionObservations,
  replaceAllObservations,
  replaceSessionObservations,
  type SessionObservationsSnapshot,
} from "./storage.js";
import type {
  Observation,
  ObservationPriority,
  ObservationalMemoryActivityEvent,
  ObservationalMemorySettings,
  ObservationalMemorySettingsInput,
} from "../types/memory.js";
import {
  parseObservationGroups,
  reconcileObservationGroupsFromReflection,
  renderObservationGroupsForReflection,
  stripObservationGroups,
  wrapInObservationGroup,
} from "./observation-groups.js";
import {
  GLOBAL_OBSERVATIONS_HEADING,
  GLOBAL_OBSERVATIONS_HINT,
  LOCAL_OBSERVATIONS_HEADING,
  LOCAL_OBSERVATIONS_HINT,
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  type RawMemoryMessage,
} from "./observational-prompts.js";

/**
 * Default `effectiveContext` when the runner doesn't specify one. 200k is a
 * comfortable mid-range target: well below frontier-model windows so memory
 * compaction kicks in early enough to keep latency and cost predictable,
 * but high enough that long-running sessions retain enough exact transcript
 * for active tool work between compactions.
 */
export const DEFAULT_EFFECTIVE_CONTEXT = 200_000;

/**
 * Ratios of `effectiveContext` that govern the local-session budgets that
 * count against the actor model's per-turn input. `messageTokens` caps the
 * raw-message tail; `observationTokens` caps the local-memory pack rendered
 * into the prefix. The system prompt and tool-call slack come out of
 * `messageTokens`'s share since the raw tail naturally absorbs whatever's
 * left. The cross-session pack is sized separately (see
 * `GLOBAL_CONTEXT_TOKEN_BUDGET`) because scaling it with the model window
 * would explode the prompt prefix on frontier-window models without
 * making the global pack itself any more useful.
 */
export const MEMORY_BUDGET_RATIOS = {
  /** Raw-message compaction trigger (per turn). */
  messageTokens: 0.6,
  /** Local-memory pack ceiling between reflection events. */
  observationTokens: 0.325,
} as const;

/**
 * Fixed token cap on the cross-session global memory pack rendered above
 * the local-session compacted view. Held constant (rather than derived from
 * `effectiveContext`) because the pack's value is bounded by retrieval
 * quality, not by the actor's window: a 1M-window model does not benefit
 * from 75k of densest-recall reflections injected on every turn, it just
 * pays for them. 8k is enough headroom for the top tens of reflections
 * the ranker would actually choose, and the long tail stays reachable via
 * the `recall_memory` tool when the turn needs it.
 */
export const GLOBAL_CONTEXT_TOKEN_BUDGET = 8_000;

/**
 * Post-observation wire-tail target as a fraction of the observation
 * trigger (`observation.messageTokens`). When raw wire-tail tokens cross
 * the trigger, the observer condenses the tail into observations and the
 * eviction horizon advances until the surviving tail fits this target.
 * 0.5 reclaims half the trigger each pass; the next observation fires
 * sooner, trading larger condensation steps for smaller, more frequent
 * ones. Doesn't count toward the actor budget because it's bounded above
 * by the trigger, which already does.
 */
export const OBSERVATION_BUFFER_RATIO = 0.5;

/**
 * Per-reflection condensation target as a fraction of the reflection
 * trigger (`reflection.observationTokens`). Lower than
 * `OBSERVATION_BUFFER_RATIO` because the reflector folds the previous
 * reflection row back into the next pass, so a tighter per-pass target
 * keeps the rolled-up row from creeping toward the trigger over many
 * reflections. 0.4 reclaims 60% of the trigger each pass; the next
 * reflection fires sooner but each pass is cheaper and the steady-state
 * row stays denser.
 */
export const REFLECTION_BUFFER_RATIO = 0.4;

/**
 * Token budgets that govern observer-call quality rather than actor-context
 * fit. These never appear in the actor model's request, so they're decoupled
 * from `effectiveContext` and held at fixed values that the observer model
 * handles reliably across providers.
 */
export const FIXED_OBSERVER_BUDGETS = {
  /**
   * Cap on transcript tokens sent to one observer call. The runner
   * trims the unobserved tail to this size from the newest end before
   * calling the observer, so a long run of `hasMemory=false` turns
   * can't grow the prompt past the memory model's hard window. The
   * dropped prefix was already shown to the observer on previous turns
   * — it was the same `hasMemory=false` content that kept the tail
   * growing — so trimming it is information-preserving in practice.
   * When the budget cuts through a message, that message is included
   * partially (tail kept, head sliced) rather than dropped whole.
   *
   * Sized well above any plausible single-turn payload so a normal
   * turn is never truncated. Bump this if a single turn ever needs to
   * carry more than ~35k transcript tokens.
   */
  maxTranscriptTokens: 35_000,
  /**
   * Cap on the observation log the observer is asked to produce in
   * one call. Used as both the instructed soft budget rendered into
   * the prompt and the hard enforcement threshold that triggers a
   * retry / final hard trim via `enforceObservationTokenBudget`.
   *
   * Real-world observation logs run a few hundred tokens for typical
   * exchanges (the guidelines call for 1-5 terse observations per
   * turn), so 8k is comfortable headroom for unusually rich
   * exchanges — about a 4:1 compression ceiling against the 35k
   * transcript cap, vs an effective ~100:1 compression in practice.
   */
  maxObservationLogTokens: 8_000,
  /**
   * Cap on prior-observation tokens included in the observer prompt
   * for dedupe context. Bounded so the observer never receives the
   * whole durable memory database.
   */
  previousObserverTokens: 4_000,
} as const;

/**
 * 7 days picked to keep last-week's context current while letting month-old
 * chatter decay out of the global pack. Tunable per-caller via
 * `ObservationalMemorySettingsInput.recencyHalfLifeMs`.
 */
export const DEFAULT_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 1.3 keeps reflections preferred at matched priority/recency without
 * shutting raw observations out of the global pack entirely.
 */
export const DEFAULT_REFLECTION_BIAS = 1.3;

/**
 * 100 gives manual (user-curated) rows `ln(100) ≈ 4.6` of score, a ~32-day
 * recency head start at the default half-life. Intentionally far above
 * DEFAULT_REFLECTION_BIAS because curated rows should dominate the global
 * pack rather than merely edge out raw observations.
 */
export const DEFAULT_MANUAL_BIAS = 100;

/**
 * 1.5 gives single user-added (`note`) rows just above DEFAULT_REFLECTION_BIAS:
 * a hand-vouched note edges out auto-synthesized reflections without the 100x
 * dominance of a `duet train` corpus, and notes stay reflect-eligible so they
 * age and fold normally.
 */
export const DEFAULT_NOTE_BIAS = 1.5;

export interface DerivedMemoryBudgets {
  observation: {
    messageTokens: number;
    maxTranscriptTokens: number;
    maxObservationLogTokens: number;
    bufferActivation: number;
    previousObserverTokens: number;
  };
  reflection: {
    observationTokens: number;
    bufferActivation: number;
  };
  globalContextTokenBudget: number;
}

/**
 * Compute every numeric token budget the memory pipeline uses from a single
 * `effectiveContext` value. Values are floored to integers and clamped to
 * at least 1 so tiny test-mode contexts still satisfy `buffer < trigger`
 * after rounding.
 */
export function deriveMemoryBudgets(effectiveContext: number): DerivedMemoryBudgets {
  const positive = Math.max(1, Math.floor(effectiveContext));
  const messageTokens = atLeastOne(MEMORY_BUDGET_RATIOS.messageTokens * positive);
  const observationTokens = atLeastOne(MEMORY_BUDGET_RATIOS.observationTokens * positive);
  // Clamp the global pack to the actor's window in degenerate small-context
  // test fixtures so the pack can never grow larger than the budget the
  // actor is sized for. Production windows are always well above 8k.
  const globalContextTokenBudget = atLeastOne(Math.min(GLOBAL_CONTEXT_TOKEN_BUDGET, positive));
  return {
    observation: {
      messageTokens,
      maxTranscriptTokens: FIXED_OBSERVER_BUDGETS.maxTranscriptTokens,
      maxObservationLogTokens: FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
      bufferActivation: atLeastOne(OBSERVATION_BUFFER_RATIO * messageTokens),
      previousObserverTokens: FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    },
    reflection: {
      observationTokens,
      bufferActivation: atLeastOne(REFLECTION_BUFFER_RATIO * observationTokens),
    },
    globalContextTokenBudget,
  };
}

function atLeastOne(value: number): number {
  return Math.max(1, Math.floor(value));
}

export interface ObserverResult {
  /** Whether the observer found durable information worth writing to memory. */
  hasMemory: boolean;
  /** New observation log text extracted from raw messages. */
  observations: string;
  /**
   * Ids of prior memories that the observer reports as having actually
   * informed the assistant's response in this exchange. The runner
   * advances `lastUsedAt` on these rows so reused memories keep
   * climbing in the global ranking even as their original
   * `createdAt` recedes.
   */
  usedObservationIds?: string[];
  /** Current task state distilled for continuity and optional thread metadata. */
  currentTask?: string;
  /** Hint for the actor's next response after context has been compressed. */
  suggestedContinuation?: string;
  /** Optional short title when the observer is asked to name the session/thread. */
  threadTitle?: string;
}

function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
}

export interface ReflectorReflection {
  /** One durable insight rendered as a single small row (~30-150 tokens). */
  content: string;
  /** Priority for the row. Defaults to "high" when omitted. */
  priority?: ObservationPriority;
  /** ISO YYYY-MM-DD the insight is anchored to. Defaults to today when omitted. */
  observedDate?: string;
}

export interface ReflectorResult {
  /**
   * Atomic reflection rows produced from the batch. The global-prune
   * path persists each row as its own `Observation` so recall
   * freshness can rank, decay, and refresh each insight independently.
   */
  reflections: ReflectorReflection[];
  /** Hint for the actor's next response after reflection rewrites memory. */
  suggestedContinuation?: string;
}

const observerResultSchema = Type.Object({
  hasMemory: Type.Boolean({
    description:
      "Set true when the message history contains durable information worth remembering. Set false when there is nothing useful to store.",
  }),
  observations: Type.String({
    description:
      "New observation log text extracted from the raw message history. When hasMemory is false, return an empty string.",
  }),
  usedObservationIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Ids of prior memories from the [memory id: mem_...] markers in the existing observations block whose content actually informed the assistant's response in this exchange. Drives the lastUsedAt freshness signal so reused memories keep surfacing. When multiple existing memories describe the same fact, cite only the single best one (most specific, highest priority, most recent) — never every duplicate, otherwise stale duplicates get uniformly refreshed and decay-ranking breaks. Omit or return [] when no prior memory was leaned on.",
    }),
  ),
  currentTask: Type.Optional(
    Type.String({
      description: "Current task state distilled for continuity.",
    }),
  ),
  suggestedContinuation: Type.Optional(
    Type.String({
      description: "Hint for the actor's next response after context compression.",
    }),
  ),
  threadTitle: Type.Optional(
    Type.String({
      description: "Short 2-5 word title when thread title generation is requested.",
    }),
  ),
});

const observerResultTool = {
  name: "recordObservations",
  description: "Return extracted observational memory fields.",
  parameters: observerResultSchema,
};

const reflectorResultSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      content: Type.String({
        description:
          "One durable insight told as a self-contained mini-narrative (~150-600 tokens, 2-5 sentences or one short paragraph). Each row must stand alone as a bumpable unit of memory AND be readable cold — include the trigger that surfaced it, the path taken, the decision or outcome, and the rationale or higher-level lesson where one exists. A bare factual headline without that context is wrong; expand it. Never wrap multiple distinct insights in one row.",
      }),
      priority: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
          description:
            "Importance signal for recall ranking. Defaults to high when omitted; use medium/low for routine or tentative material.",
        }),
      ),
      observedDate: Type.Optional(
        Type.String({
          description: "ISO YYYY-MM-DD the insight is anchored to. Defaults to today when omitted.",
        }),
      ),
    }),
    {
      description:
        "Atomic reflection rows. Each row is its own self-contained mini-narrative — trigger → journey → decision → lesson — not a bare fact headline. Prefer many narrative rows over one giant summary; deduplicate across rows and keep cross-session themes as their own rows.",
    },
  ),
  suggestedContinuation: Type.Optional(
    Type.String({
      description: "Hint for the actor's next response after reflection rewrites memory.",
    }),
  ),
});

const reflectorResultTool = {
  name: "reflectObservations",
  description:
    "Return an array of atomic reflection rows. Each row is one durable insight, told with enough context (trigger, journey, decision, lesson) to be understood on its own; never concatenate multiple insights into one row.",
  parameters: reflectorResultSchema,
};

export interface ModelByInputTokensConfig {
  upTo: Record<number, Model<any>>;
}

export class ModelByInputTokens {
  private readonly thresholds: Array<{ limit: number; model: Model<any> }>;

  constructor(config: ModelByInputTokensConfig) {
    const entries = Object.entries(config.upTo);
    if (entries.length === 0) {
      throw new Error('ModelByInputTokens requires at least one threshold in "upTo"');
    }
    this.thresholds = entries
      .map(([limit, model]) => {
        const parsed = Number(limit);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(
            `ModelByInputTokens threshold keys must be positive numbers. Got: ${limit}`,
          );
        }
        return { limit: parsed, model };
      })
      .sort((a, b) => a.limit - b.limit);
  }

  resolve(inputTokens: number): Model<any> {
    for (const { limit, model } of this.thresholds) {
      if (inputTokens <= limit) {
        return model;
      }
    }
    const maxLimit = this.thresholds[this.thresholds.length - 1]!.limit;
    throw new Error(
      `ModelByInputTokens: input token count (${inputTokens}) exceeds the largest configured threshold (${maxLimit}).`,
    );
  }

  getThresholds(): number[] {
    return this.thresholds.map((threshold) => threshold.limit);
  }
}

export interface ObservationalContextTransformOptions {
  memory: MemoryContextCache;
  /**
   * Caller-resolved effective context window (already clamped to the
   * model's hard limit). All numeric memory budgets are derived from this.
   */
  effectiveContext: number;
  settings?: ObservationalMemorySettingsInput;
  /**
   * Awaited inside the budget-trigger block, before the eviction walk
   * advances the horizon. The runner wires it to drain unobserved
   * messages into durable memory and refresh the frozen context pack,
   * so the post-eviction render carries an observation that covers
   * what just got dropped. The prompt cache is already invalidating
   * because eviction changes the message tail, so paying the drain +
   * refresh at this boundary piggybacks on a cache miss the model is
   * already paying.
   */
  onCompaction?: (messages: AgentMessage[]) => Promise<void>;
  /**
   * Sticky eviction point. The transform applies this horizon to the
   * message list before checking either budget, then advances it in place
   * when a budget is exceeded. Pi-agent re-runs `transformContext` on
   * every turn against the full untransformed history; the sticky horizon
   * keeps the dropped prefix content-deterministic across turns so the
   * provider's prompt cache stays valid between eviction events. Callers
   * (the runner) own the lifetime of this object — typically a single
   * instance per `Agent`, reset on session resume.
   */
  horizon: WireGuardHorizon;
}

export interface ObservationalMemoryUpdateOptions {
  /**
   * Memory session that owns the durable memory rows. The observer and
   * reflector wrap each storage call in `session.withDb`, so the
   * cross-process lock is held only for the duration of each query and
   * a peer duet CLI can step in between writes.
   */
  session: MemorySession;
  /** Frozen context-pack cache; queried for the global memories the observer can attribute usage against. */
  memory: MemoryContextCache;
  /**
   * Session that owns the runner. Stamped onto every observation and
   * reflection produced by this update so the loader can later split
   * memory into the current session's local layer and every other
   * session's global layer.
   */
  sessionId?: string;
  /**
   * Caller-resolved effective context window (already clamped to the
   * model's hard limit). All numeric memory budgets are derived from this.
   */
  effectiveContext: number;
  settings?: ObservationalMemorySettingsInput;
  actorModel: string;
  messages: AgentMessage[];
  /**
   * Working directory the runner is executing in. Stored on the
   * resulting `<observation-group>` wrapper as a `cwd` attribute and
   * exposed to the observer/in-session reflector prompts so project
   * context is preserved in every row — essential when memory is
   * read back weeks later or across repos.
   */
  cwd?: string;
  /** Optional wall-clock override stamped onto the observation row. Used by the longmemeval harness to anchor observations to haystack session dates instead of Date.now(). */
  now?: Date;
  onUsage?: (usage: Usage) => void;
  onActivity?: (event: ObservationalMemoryActivityEvent) => void;
}

export interface ObservationalMemoryUpdateResult {
  observations: Observation[];
  reflections: Observation[];
}

/**
 * Resolve user-provided non-budget knobs and merge with the budgets derived
 * from `effectiveContext`. Callers must pass `effectiveContext` already
 * clamped to the actor model's hard window when one is known; the function
 * itself only validates that the value is positive.
 */
export function resolveObservationalMemorySettings(
  effectiveContext: number,
  input?: ObservationalMemorySettingsInput,
): ObservationalMemorySettings {
  const partial = input ?? {};
  const budgets = deriveMemoryBudgets(effectiveContext);

  return {
    globalContextTokenBudget: budgets.globalContextTokenBudget,
    recencyHalfLifeMs: partial.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS,
    reflectionBias: partial.reflectionBias ?? DEFAULT_REFLECTION_BIAS,
    manualBias: partial.manualBias ?? DEFAULT_MANUAL_BIAS,
    noteBias: partial.noteBias ?? DEFAULT_NOTE_BIAS,
    observation: {
      messageTokens: budgets.observation.messageTokens,
      maxTranscriptTokens: budgets.observation.maxTranscriptTokens,
      maxObservationLogTokens: budgets.observation.maxObservationLogTokens,
      bufferActivation: budgets.observation.bufferActivation,
      previousObserverTokens: budgets.observation.previousObserverTokens,
      instruction: partial.observation?.instruction,
      threadTitle: partial.observation?.threadTitle,
    },
    reflection: {
      observationTokens: budgets.reflection.observationTokens,
      bufferActivation: budgets.reflection.bufferActivation,
      instruction: partial.reflection?.instruction,
    },
    retrieval: partial.retrieval ?? true,
  };
}

/**
 * Sanity-check the derived budgets. The ratio derivation in
 * `deriveMemoryBudgets` already enforces `buffer < trigger` by construction,
 * but tiny `effectiveContext` values (used by tests) can collapse triggers
 * to single-digit token counts where the rounded buffer would tie. Validate
 * at use-time so a misconfigured runner fails loudly rather than silently
 * producing an empty raw-message tail.
 */
export function validateObservationalMemorySettings(settings: ObservationalMemorySettings): void {
  if (settings.observation.bufferActivation <= 0) {
    throw new Error(
      `observation.bufferActivation must be a positive retained-token budget, got ${settings.observation.bufferActivation}`,
    );
  }

  if (settings.observation.bufferActivation >= settings.observation.messageTokens) {
    throw new Error(
      `observation.bufferActivation (${settings.observation.bufferActivation}) must be lower than observation.messageTokens (${settings.observation.messageTokens})`,
    );
  }

  if (settings.reflection.bufferActivation <= 0) {
    throw new Error(
      `reflection.bufferActivation must be a positive retained-token budget, got ${settings.reflection.bufferActivation}`,
    );
  }

  if (settings.reflection.bufferActivation >= settings.reflection.observationTokens) {
    throw new Error(
      `reflection.bufferActivation (${settings.reflection.bufferActivation}) must be lower than reflection.observationTokens (${settings.reflection.observationTokens})`,
    );
  }
}

export function createObservationalContextTransform(options: ObservationalContextTransformOptions) {
  const settings = resolveObservationalMemorySettings(options.effectiveContext, options.settings);
  validateObservationalMemorySettings(settings);

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const observableMessages = stripObservationalContextMessages(messages);
    let retainedMessages = applyEvictionHorizon(
      observableMessages,
      options.horizon.evictionHorizon,
    );

    // Trigger condition: either budget exceeded under the current sticky
    // horizon. The token budget is the primary gate — it tracks what the
    // provider actually bills for text + tool I/O. The byte budget is the
    // image safety net: inline images carry hundreds of KB of base64
    // payload at a bounded, provider-specific per-image token charge that
    // the `ceil(bytes/4)` heuristic cannot estimate accurately, so a few
    // large screenshots can blow past any reasonable wire size while the
    // token estimate still looks fine. Eviction advances the horizon
    // enough to satisfy both targets in one block so the next several
    // turns grow back without retriggering.
    //
    // Token accounting uses `ceil(wireBytes / 4)`, the same heuristic the
    // runner reports on `TurnUsageFields.contextWindowUsage.messages`.
    // `JSON.stringify` length for structured blocks (toolCall, toolResult,
    // thinking), so heavy tool sessions trigger compaction at the same
    // scale the provider bills — unlike `agentMessagesToRaw`, which
    // collapses non-text blocks into tiny preview strings and lets the
    // wire grow well past `effectiveContext` before tripping.
    const candidateBytes = calculateWireBytes(retainedMessages);
    const candidateTokens = calculateWireTokens(retainedMessages);
    const tokenTrigger = settings.observation.messageTokens;
    const tokenTarget = settings.observation.bufferActivation;

    if (candidateTokens >= tokenTrigger || candidateBytes >= WIRE_BYTE_TRIGGER) {
      // Drain unobserved messages into durable memory before the
      // horizon walks past them so the post-eviction render sees an
      // observation that covers the dropped span. The handler swallows
      // its own failures — budget compliance below is unconditional.
      await options.onCompaction?.(observableMessages);
      options.horizon.evictionHorizon = findEvictionHorizon(
        observableMessages,
        options.horizon.evictionHorizon,
        (candidate) => {
          const bytes = calculateWireBytes(candidate);
          const tokens = calculateWireTokens(candidate);
          return tokens <= tokenTarget && bytes <= WIRE_BYTE_TARGET;
        },
      );
      retainedMessages = applyEvictionHorizon(observableMessages, options.horizon.evictionHorizon);
    }

    // Render the frozen context pack rather than every observation
    // currently in the store. The pack is rebuilt only at compaction
    // events (see memory/context-pack.ts), so the rendered prefix stays
    // content-deterministic across turns and the provider's prompt
    // cache survives until the next compaction.
    const pack = options.memory.getContextPack();
    const rendered = renderContextPack(pack);
    if (!rendered) {
      return retainedMessages;
    }

    return [
      buildObservationContextMessage(rendered),
      buildContinuationMessage(),
      ...retainedMessages,
    ];
  };
}

/**
 * Compose the two-layer memory section. Global rows render first
 * (most stable cross-session signal), local rows render second
 * (chronological compaction summary of the current session). The
 * fixed render order matches the prompt assembly: system prompt →
 * memory section → message history.
 */
function renderContextPack(pack: { global: Observation[]; local: Observation[] }): string {
  const sections: string[] = [];
  if (pack.global.length > 0) {
    sections.push(
      [
        "<global_observations>",
        GLOBAL_OBSERVATIONS_HEADING,
        GLOBAL_OBSERVATIONS_HINT,
        pack.global.map((observation) => observation.content).join("\n\n"),
        "</global_observations>",
      ].join("\n\n"),
    );
  }
  if (pack.local.length > 0) {
    sections.push(
      [
        "<local_observations>",
        LOCAL_OBSERVATIONS_HEADING,
        LOCAL_OBSERVATIONS_HINT,
        pack.local.map((observation) => observation.content).join("\n\n"),
        "</local_observations>",
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

export async function updateObservationalMemory(
  options: ObservationalMemoryUpdateOptions,
): Promise<ObservationalMemoryUpdateResult> {
  const settings = resolveObservationalMemorySettings(options.effectiveContext, options.settings);
  validateObservationalMemorySettings(settings);
  const rawMessages = agentMessagesToRaw(stripObservationalContextMessages(options.messages));
  // Local snapshot is the only set whose range markers gate
  // `getUnobservedMessageTail`. The observer's prior-context input
  // includes both this and the global pack rendered with id markers
  // so the model can attribute usage back to specific cross-session
  // memories.
  const localSnapshot = options.sessionId
    ? await readSessionObservations(options.session, options.sessionId)
    : { observations: [], estimatedObservationTokens: 0 };
  const globalPack = options.memory.getContextPack().global;
  const unobservedMessages = getUnobservedMessageTail(rawMessages, localSnapshot.observations);
  const result: ObservationalMemoryUpdateResult = {
    observations: [],
    reflections: [],
  };

  if (unobservedMessages.length > 0) {
    emitMemoryActivity(options.onActivity, {
      phase: "observation",
      status: "running",
      message: "Observing conversation into memory...",
    });
    const { observation, usageBumped } = await activateObservations({
      session: options.session,
      messages: unobservedMessages,
      previousLocalObservations: localSnapshot.observations,
      attributableMemories: globalPack,
      settings,
      sessionId: options.sessionId,
      model: options.actorModel,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.now ? { now: options.now } : {}),
      onUsage: options.onUsage,
    });
    if (observation) {
      result.observations.push(observation);
    }
    // Only surface a completion event when something actually changed in
    // memory. If activation produced no new observation and bumped no prior
    // memories, suppress the completed event entirely so the TUI does not
    // render an empty `[memory:observation]` section.
    if (observation || usageBumped.length > 0) {
      emitMemoryActivity(options.onActivity, {
        phase: "observation",
        status: "completed",
        message: buildObservationCompletedMessage(observation, usageBumped.length),
        ...(observation ? { observations: [observation] } : {}),
        ...(usageBumped.length > 0 ? { usageBumpedObservations: usageBumped } : {}),
      });
    }
  }

  if (options.sessionId) {
    const refreshed = await readSessionObservations(options.session, options.sessionId);
    if (refreshed.estimatedObservationTokens >= settings.reflection.observationTokens) {
      emitMemoryActivity(options.onActivity, {
        phase: "reflection",
        status: "running",
        message: "Reflecting memory observations...",
      });
      const reflections = await reflectObservations({
        session: options.session,
        sessionObservations: refreshed.observations,
        settings,
        sessionId: options.sessionId,
        model: options.actorModel,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        onUsage: options.onUsage,
      });
      if (reflections) {
        result.reflections.push(...reflections);
      }
      emitMemoryActivity(options.onActivity, {
        phase: "reflection",
        status: "completed",
        message: reflections ? "Memory reflection recorded." : "Memory reflection complete.",
        ...(reflections ? { observations: reflections } : {}),
      });
    }
  }

  return result;
}

export function optimizeObservationsForContext(observations: string): string {
  let optimized = stripObservationGroups(observations);
  optimized = optimized.replace(/🟡\s*/g, "");
  optimized = optimized.replace(/🟢\s*/g, "");
  optimized = optimized.replace(/\[(?![\d\s]*items collapsed)[^\]]+\]/g, "");
  optimized = optimized.replace(/\s*->\s*/g, " ");
  optimized = optimized.replace(/ +/g, " ");
  optimized = optimized.replace(/\n{3,}/g, "\n\n");
  return optimized.trim();
}

function buildObservationCompletedMessage(
  observation: Observation | undefined,
  usageBumpedCount: number,
): string {
  const base = observation ? "Memory observation recorded." : "Memory observation complete.";
  if (usageBumpedCount <= 0) return base;
  const noun = usageBumpedCount === 1 ? "memory" : "memories";
  return `${base} Reinforced ${usageBumpedCount} prior ${noun}.`;
}

function emitMemoryActivity(
  handler: ObservationalMemoryUpdateOptions["onActivity"],
  event: ObservationalMemoryActivityEvent,
): void {
  handler?.(event);
}

function buildObservationContextMessage(observations: string): AgentMessage {
  const optimized = optimizeObservationsForContext(observations);
  return {
    role: "user",
    content: `<system-reminder>${OBSERVATION_CONTEXT_PROMPT}\n\n<observations>\n${optimized}\n</observations>\n\n${OBSERVATION_CONTEXT_INSTRUCTIONS}</system-reminder>`,
    timestamp: Date.now(),
  };
}

function buildContinuationMessage(): AgentMessage {
  return {
    role: "user",
    content: `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
    timestamp: Date.now(),
  };
}

/**
 * Drop synthetic memory/continuation reminders injected by the actor
 * context transform so callers see only the "real" conversation messages
 * the observer and wire-shaping pipelines reason about. Safe to call on a
 * message list whether or not the transform has run.
 */
export function stripObservationalContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isObservationalContextMessage(message));
}

function isObservationalContextMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const text = serializeMessageForObserver(message).textPreview.trim();
  // Context transforms inject durable memory as synthetic user reminders for the
  // actor. Observers must ignore those reminders so a tiny new exchange does not
  // re-observe the entire durable memory database or send it back to the memory
  // model as raw message history.
  return (
    text.startsWith(`<system-reminder>${OBSERVATION_CONTEXT_PROMPT}`) ||
    text === `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`
  );
}

interface ActivateObservationsArgs {
  session: MemorySession;
  messages: RawMemoryMessage[];
  /** Prior observations from the same session, used for dedupe context. */
  previousLocalObservations: Observation[];
  /** Cross-session memories rendered to the actor; the observer attributes usage against these. */
  attributableMemories: Observation[];
  settings: ObservationalMemorySettings;
  sessionId: string | undefined;
  model: string;
  /** Working directory recorded on the observation-group wrapper and surfaced to the observer prompt. */
  cwd?: string;
  /** Optional wall-clock override used to stamp the resulting observation. Benchmarks (longmemeval) pass haystack dates here so temporal-reasoning works. */
  now?: Date;
  onUsage?: (usage: Usage) => void;
}

interface ActivateObservationsResult {
  observation?: Observation;
  /** Prior memories the bump actually applied to (intersection of usedIds and candidates). */
  usageBumped: Observation[];
}

async function activateObservations(
  args: ActivateObservationsArgs,
): Promise<ActivateObservationsResult> {
  const observations = await observe(
    args.messages,
    args.previousLocalObservations,
    args.attributableMemories,
    args.settings,
    args.model,
    args.cwd,
    args.onUsage,
  );
  // Usage attribution applies whether or not the observer had new
  // memory worth recording — a turn can lean on a prior memory even
  // when nothing new is durable.
  const usageBumped = await applyUsageBumps(
    args.session,
    args.attributableMemories,
    observations.usedObservationIds,
  );

  if (!observations.hasMemory || !observations.observations.trim()) {
    // The same low-signal messages may become useful context for a
    // later suffix, so do not record an empty checkpoint.
    return { usageBumped };
  }

  const range = `${args.messages[0]?.id ?? "unknown"}:${args.messages[args.messages.length - 1]?.id ?? "unknown"}`;
  const stamp = (args.now ?? new Date()).toISOString();
  const observation = await appendObservation(args.session, {
    kind: "observation",
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    observedDate: stamp.slice(0, 10),
    timeOfDay: stamp.slice(11, 16),
    priority: inferPriority(observations.observations),
    source: { kind: "system" },
    content: wrapInObservationGroup(
      observations.observations,
      range,
      undefined,
      undefined,
      args.cwd,
    ),
    tags: ["observational-memory"],
  });
  return { observation, usageBumped };
}

/**
 * Bump `last_used_at` for the subset of `usedObservationIds` that
 * actually corresponds to an attributable memory id rendered to the
 * observer. Filtering against the candidate set rejects hallucinated
 * ids without an extra round-trip; the database column accepts any
 * ids unconditionally so a strict guard here is the only line of
 * defense.
 */
async function applyUsageBumps(
  session: MemorySession,
  candidates: Observation[],
  usedIds: string[] | undefined,
): Promise<Observation[]> {
  if (!usedIds || usedIds.length === 0) return [];
  const candidatesById = new Map(candidates.map((c) => [c.id, c]));
  const validated = usedIds
    .map((id) => candidatesById.get(id))
    .filter((observation): observation is Observation => Boolean(observation));
  if (validated.length === 0) return [];
  await bumpLastUsed(
    session,
    validated.map((observation) => observation.id),
    Date.now(),
  );
  return validated;
}

interface ReflectObservationsArgs {
  session: MemorySession;
  sessionObservations: Observation[];
  settings: ObservationalMemorySettings;
  sessionId: string;
  model: string;
  /** Working directory surfaced to the in-session reflector prompt so the rolled-up blob retains project context. */
  cwd?: string;
  onUsage?: (usage: Usage) => void;
}

async function reflectObservations(
  args: ReflectObservationsArgs,
): Promise<Observation[] | undefined> {
  const { session, sessionObservations, settings, sessionId, model, cwd, onUsage } = args;
  const source = sessionObservations.map((observation) => observation.content).join("\n\n");
  const rendered = renderObservationGroupsForReflection(source) ?? source;
  const targetTokens = settings.reflection.bufferActivation;
  const result = await generateStructuredOutput({
    model,
    tool: reflectorResultTool,
    systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction, { cwd }),
    prompt: buildReflectorPrompt(rendered, targetTokens),
    onUsage,
  });
  // The in-session reflector still produces a single observation row,
  // so collapse the array back into one blob and let the observation-
  // group reconciliation helpers run against the joined text.
  const joined = joinReflectorRows(result.reflections);
  const text = await enforceObservationTokenBudget({
    text: joined,
    targetTokens,
    retry: async (actualTokens) => {
      const retryResult = await generateStructuredOutput({
        model,
        tool: reflectorResultTool,
        systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction, { cwd }),
        prompt: buildReflectorPrompt(rendered, targetTokens, { actualTokens }),
        onUsage,
      });
      return joinReflectorRows(retryResult.reflections);
    },
  });
  if (!text) {
    return undefined;
  }

  const reconciled = reconcileObservationGroupsFromReflection(text, source) ?? text;
  const now = Date.now();
  const reflected: Observation = {
    id: createMemoryId(),
    createdAt: now,
    lastUsedAt: now,
    kind: "reflection",
    sessionId,
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: "high",
    source: { kind: "system" },
    content: reconciled,
    tags: ["observational-memory", "reflection"],
  };
  // Session-scoped replace: only this session's rows are removed and
  // replaced by the new reflection. Other sessions' rows in the
  // global pool are untouched, which is what makes cross-session
  // memory durable past a reflection event.
  await replaceSessionObservations(session, sessionId, [reflected]);
  return [reflected];
}

/**
 * Sentinel session id used by `reflectAllObservations` to stamp the
 * reflection rows produced from the cross-session pool. Lets the
 * loader/UI distinguish a global prune-reflection from a per-session one
 * without needing a new column.
 */
export const GLOBAL_REFLECTION_SESSION_ID = "__global_reflection__";

/**
 * Default minimum age, in days, that a raw observation must reach before
 * the global reflect prune (`duet memory reflect`) is allowed to fold it
 * into a reflection row and delete the original.
 *
 * --- Why a min-age gate exists (read before changing) -----------------
 *
 * The global prune *deletes* the eligible source rows after condensing
 * them. If a long-lived session is later resumed and finds its own local
 * observation rows wiped, the runner's `getUnobservedMessageTail` loses
 * its observation-group range markers — so the next observer call treats
 * the entire session tail as unobserved and re-observes only the newest
 * `FIXED_OBSERVER_BUDGETS.maxTranscriptTokens` (~35k tokens) of raw
 * messages. Everything older than that newest slice is silently dropped
 * by `trimMessagesToTranscriptBudget`, which walks newest→oldest. For
 * sessions that had accumulated rich local condensation, that older
 * content is genuinely lost: the actor's wire eviction horizon already
 * shaped those messages off-wire, so they cannot be re-observed from the
 * raw tail. The global reflection row preserves cross-session themes,
 * but not the session-specific specifics.
 *
 * 3 days is the line where the cost-of-loss flips. After ~3 days a human
 * no longer remembers session specifics anyway, only the higher-level
 * shape — which is what the reflection row captures. Up to 3 days, the
 * specifics still matter for resume continuity, so we hold those rows
 * untouched.
 *
 * --- Alternatives considered and rejected (May 2026) ------------------
 *
 *   1. *Append-only with high-water-mark watermark.* Never delete; just
 *      keep appending reflection rows tagged `global-prune`. Recall
 *      ranks them above raw rows via `reflectionBias`. Pro: zero risk of
 *      resume info loss. Con: the pool grows unbounded over time and we
 *      still pay retrieval cost over every stale raw row that the
 *      reflection already supersedes. Rejected because the user
 *      explicitly wanted the pool to stay small.
 *
 *   2. *Per-session reflect+replace, batched by `session_id`.* Preserves
 *      attribution. Rejected because the whole point of the global
 *      prune is *cross-session* dedup; grouping by session forfeits
 *      that. Used only by the in-session reflector
 *      (`reflectObservations`).
 *
 *   3. *Reflect on existing reflections too.* Pro: keeps total row count
 *      bounded across many reflect runs. Rejected because reflections
 *      of reflections collapse already-condensed text into vaguer text,
 *      losing specificity each pass. The current shape preserves rows
 *      where `kind === "reflection"` (skipped as input and skipped from
 *      the deletion set), so older reflections accumulate but never
 *      degrade. A separate `duet memory compact` can later GC stale
 *      reflections by `lastUsedAt`.
 *
 *   4. *Smaller min-age (e.g. 1 day) for faster pruning.* Rejected
 *      because typical bursty work patterns (a 2-day investigation, a
 *      multi-day refactor) would lose mid-thread specifics exactly when
 *      a resume is most likely to need them.
 */
export const DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS = 3;
export const DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS =
  DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface ReflectAllOptions {
  session: MemorySession;
  /**
   * The snapshot to reflect. Callers (the CLI) read the pool once so they
   * can also print stats before the model call; passing the snapshot in
   * avoids a redundant second `SELECT` inside this function.
   */
  snapshot: SessionObservationsSnapshot;
  settings: ObservationalMemorySettings;
  model: string;
  /**
   * Override the target token budget for the reflected log produced by
   * each batch's reflector call. Defaults to
   * `settings.reflection.bufferActivation` so each batch behaves the
   * same way an in-session reflection does: condense to roughly the
   * half-trigger budget, leaving headroom before the next reflection.
   */
  targetTokens?: number;
  /**
   * Maximum input tokens packed into a single reflector batch. Defaults
   * to `settings.reflection.observationTokens` — the same trigger the
   * in-session reflector uses, so each global-prune batch is the size
   * of one natural reflection round. Multiple batches fire sequentially
   * when the eligible pool is larger; cross-session dedup still works
   * because batches are packed in chronological order, not grouped by
   * `sessionId`.
   */
  batchTokens?: number;
  /**
   * Minimum age, in milliseconds, before a non-reflection row is
   * eligible for prune. Defaults to {@link DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS}.
   * See the {@link DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS} doc for the
   * tradeoffs behind this default.
   */
  minAgeMs?: number;
  /**
   * Override of "now" for eligibility comparison. Defaults to
   * `Date.now()`. Tests pin this so the cutoff is deterministic.
   */
  now?: number;
  /**
   * When true, do not write the reflected rows back. The function still
   * runs the reflector model(s) and returns the result so callers can
   * preview the prune (`duet memory reflect --dry-run`).
   */
  dryRun?: boolean;
  onUsage?: (usage: Usage) => void;
}

export interface ReflectAllResult {
  /** Observations as they existed before the reflect call. */
  before: Observation[];
  /**
   * Rows preserved verbatim — either too fresh (younger than
   * `minAgeMs`) or already reflection rows. These are written back
   * untouched.
   */
  preserved: Observation[];
  /**
   * Raw observation rows that were eligible for condensation and were
   * folded into one of `reflections`. When `written` is true, these
   * rows have been deleted from the durable store.
   */
  eligible: Observation[];
  /** One reflection row per batch processed. Empty if nothing was eligible. */
  reflections: Observation[];
  /** Whether the pool was rewritten (false on dryRun or when reflections is empty). */
  written: boolean;
}

/** Pure-plan output of {@link planReflectionBatches}. */
export interface ReflectionBatch {
  observations: Observation[];
  estimatedTokens: number;
}

export interface PlanReflectionBatchesOptions {
  /** Observations older than this (`createdAt <= cutoff`) are eligible. */
  cutoff: number;
  /** Maximum content tokens packed into a single batch. */
  batchTokens: number;
}

/**
 * Partition a snapshot into rows preserved verbatim vs eligible batches
 * fed to the reflector. Pure function — no I/O, no model calls — so the
 * batching/eligibility rules can be unit-tested without docker/LLM.
 *
 * Rules:
 *   - Manual rows (`kind === "manual"`) are bulk-curated (`duet train`
 *     corpus syntheses) and are always preserved regardless of age — the
 *     reflect prune never compacts them. `note` rows (`duet memory add`)
 *     are NOT exempt: they fall through to the freshness check and fold
 *     like raw observations once aged, so a single note ages normally.
 *   - GLOBAL reflection rows (`kind === "reflection"` AND
 *     `sessionId === GLOBAL_REFLECTION_SESSION_ID`) are always preserved.
 *     They are the output of prior `duet memory reflect` runs and
 *     reflecting on them again would collapse already-condensed text
 *     into vaguer text. See option 3 in the
 *     {@link DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS} comment.
 *   - LOCAL reflection rows (`kind === "reflection"` with any other
 *     sessionId) are the single-blob outputs of the in-session reflector
 *     (`reflectObservations`), each still wrapped in `<observation-group>`.
 *     They ARE eligible: `duet memory reflect` is the path that breaks
 *     them up into atomic global reflection rows. Once folded, the
 *     resulting global rows carry `sessionId === GLOBAL_REFLECTION_SESSION_ID`
 *     and are preserved on subsequent runs.
 *   - Non-reflection rows with `createdAt > cutoff` are preserved (too
 *     fresh; resume-info-loss risk too high).
 *   - Everything else is eligible. Eligible rows are sorted by
 *     `createdAt` ascending and greedily packed into batches whose
 *     total `estimateTokens(content)` stays ≤ `batchTokens`. A single
 *     oversize row is allowed to occupy its own batch so we never drop
 *     rows just because they exceed the cap on their own.
 */
export function planReflectionBatches(
  observations: readonly Observation[],
  options: PlanReflectionBatchesOptions,
): { preserved: Observation[]; batches: ReflectionBatch[] } {
  const preserved: Observation[] = [];
  const eligible: Observation[] = [];
  for (const observation of observations) {
    if (observation.kind === "manual") {
      // Bulk-curated corpus rows (`duet train`); never compact them. `note`
      // rows (`duet memory add`) are intentionally absent here so they age.
      preserved.push(observation);
      continue;
    }
    if (
      observation.kind === "reflection" &&
      observation.sessionId === GLOBAL_REFLECTION_SESSION_ID
    ) {
      // Global reflection rows are the output of a prior reflect run;
      // never re-reflect them (option 3 in DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS).
      preserved.push(observation);
      continue;
    }
    if (observation.createdAt > options.cutoff) {
      preserved.push(observation);
      continue;
    }
    // Local reflection rows (kind === "reflection" with a real sessionId)
    // fall through to eligible: `duet memory reflect` folds them into
    // atomic global rows alongside raw observations.
    eligible.push(observation);
  }
  eligible.sort((a, b) => a.createdAt - b.createdAt);

  const batches: ReflectionBatch[] = [];
  let current: Observation[] = [];
  let currentTokens = 0;
  for (const observation of eligible) {
    const tokens = estimateTokens(observation.content);
    // Roll over to a new batch when adding this row would exceed the
    // cap — unless the current batch is empty, in which case we keep
    // the (oversize) row so it isn't silently dropped.
    if (current.length > 0 && currentTokens + tokens > options.batchTokens) {
      batches.push({ observations: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }
    current.push(observation);
    currentTokens += tokens;
  }
  if (current.length > 0) {
    batches.push({ observations: current, estimatedTokens: currentTokens });
  }
  return { preserved, batches };
}

/**
 * Cross-session reflect: condense each eligible batch of raw
 * observations through the reflector and replace the eligible rows
 * with one reflection row per batch. Preserved rows (fresh
 * observations and existing reflections) survive verbatim. Used by
 * `duet memory reflect` to prune the global memory store.
 *
 * Unlike `reflectObservations`, this can touch rows across all
 * sessions — the caller is asking for a global prune, not a
 * per-session compaction. See {@link DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS}
 * for the resume-info-loss tradeoffs that motivated the min-age gate
 * and the "never reflect on reflections" rule.
 *
 * Returns `undefined` only when there is nothing eligible *and* nothing
 * preserved (empty store). When the store has only fresh/reflection
 * rows, returns a result with empty `eligible`/`reflections` and
 * `written: false` so callers can report "nothing to prune" without
 * conflating it with an empty store.
 */
export async function reflectAllObservations(
  options: ReflectAllOptions,
): Promise<ReflectAllResult | undefined> {
  const { session, snapshot, settings, model, dryRun, onUsage } = options;
  if (snapshot.observations.length === 0) {
    return undefined;
  }

  const minAgeMs = options.minAgeMs ?? DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS;
  const now = options.now ?? Date.now();
  const cutoff = now - minAgeMs;
  const batchTokens = options.batchTokens ?? settings.reflection.observationTokens;
  const targetTokens = options.targetTokens ?? settings.reflection.bufferActivation;

  const { preserved, batches } = planReflectionBatches(snapshot.observations, {
    cutoff,
    batchTokens,
  });

  if (batches.length === 0) {
    return {
      before: snapshot.observations,
      preserved,
      eligible: [],
      reflections: [],
      written: false,
    };
  }

  const eligible = batches.flatMap((batch) => batch.observations);
  const reflections: Observation[] = [];
  for (const batch of batches) {
    const reflectionRows = await reflectBatch({
      batch,
      settings,
      model,
      targetTokens,
      onUsage,
    });
    reflections.push(...reflectionRows);
  }
  // `reflections.length === 0` here means every batch returned an empty
  // array — no model row survived sanitation. The eligible rows stay
  // unprocessed in that case (no write below) so the next reflect run
  // can try again.

  const written = !dryRun && reflections.length > 0;
  if (written) {
    // Single-write replacement keeps the storage transaction atomic:
    // eligible rows disappear and new reflection rows appear together,
    // never leaving a peer CLI looking at a half-pruned pool.
    await replaceAllObservations(session, [...preserved, ...reflections]);
  }

  return {
    before: snapshot.observations,
    preserved,
    eligible,
    reflections,
    written,
  };
}

/**
 * Soft per-row token budget when splitting the reflection target
 * across rows. Each row is a single insight (~30-150 tokens) so a
 * modest floor keeps a row from being trimmed to a stub, but the
 * floor stays low enough that combined output still fits inside a
 * tight global `targetTokens` budget when callers pass one.
 */
const MIN_REFLECTION_ROW_TOKENS = 120;

/**
 * Run the reflector against one eligible batch and emit one
 * `Observation` per insight the model returned. The token budget is
 * enforced by trimming each row to its share of `targetTokens`: rows
 * are independent insights, so retrying the whole batch when only one
 * row is over budget would waste a model call without changing the
 * other rows.
 */
async function reflectBatch(args: {
  batch: ReflectionBatch;
  settings: ObservationalMemorySettings;
  model: string;
  targetTokens: number;
  onUsage?: (usage: Usage) => void;
}): Promise<Observation[]> {
  const { batch, settings, model, targetTokens, onUsage } = args;
  const source = batch.observations.map((observation) => observation.content).join("\n\n");
  const result = await generateStructuredOutput({
    model,
    tool: reflectorResultTool,
    systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction),
    prompt: buildReflectorPrompt(source, targetTokens),
    onUsage,
  });
  const rows = result.reflections ?? [];
  if (rows.length === 0) return [];

  const perRowBudget = Math.max(MIN_REFLECTION_ROW_TOKENS, Math.floor(targetTokens / rows.length));
  const today = new Date().toISOString().slice(0, 10);
  const timeOfDay = new Date().toISOString().slice(11, 16);
  const observations: Observation[] = [];
  let combinedTokens = 0;
  for (const row of rows) {
    const sanitized = sanitizeObservationLines((row.content ?? "").trim());
    if (!sanitized) continue;
    const trimmed = trimObservationTextToTokenBudget(sanitized, perRowBudget);
    if (!trimmed) continue;
    const rowTokens = estimateTokens(trimmed);
    // Combined budget cap: once cumulative row tokens would exceed the
    // caller's `targetTokens`, drop the remaining rows rather than
    // letting per-row floors blow past the global budget. Always keep at
    // least one row so a tiny budget still produces output.
    if (observations.length > 0 && combinedTokens + rowTokens > targetTokens) {
      break;
    }
    combinedTokens += rowTokens;
    const now = Date.now();
    observations.push({
      id: createMemoryId(),
      createdAt: now,
      lastUsedAt: now,
      kind: "reflection",
      sessionId: GLOBAL_REFLECTION_SESSION_ID,
      observedDate: row.observedDate ?? today,
      timeOfDay,
      priority: row.priority ?? "high",
      source: { kind: "system" },
      content: trimmed,
      tags: ["observational-memory", "reflection", "global-prune"],
    });
  }
  return observations;
}

function joinReflectorRows(rows: ReflectorReflection[] | undefined): string {
  if (!rows || rows.length === 0) return "";
  return rows
    .map((row) => (row.content ?? "").trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
}

async function observe(
  messages: RawMemoryMessage[],
  previousLocalObservations: Observation[],
  attributableMemories: Observation[],
  settings: ObservationalMemorySettings,
  model: string,
  cwd: string | undefined,
  onUsage?: (usage: Usage) => void,
): Promise<ObserverResult> {
  const transcriptBudget = settings.observation.maxTranscriptTokens;
  const observationLogBudget = settings.observation.maxObservationLogTokens;
  // Trim the unobserved tail from the oldest end so the observer call
  // never overflows the memory model's hard window. A long run of
  // `hasMemory=false` turns is exactly how a tail grows past this
  // budget — and each of those older turns was already shown to the
  // observer (and rejected as low-signal) on a previous call. Dropping
  // them here is information-preserving in practice; the newest tail
  // is what carries any durable signal worth recording.
  const trimmedMessages = trimMessagesToTranscriptBudget(messages, transcriptBudget);
  const systemPrompt = buildObserverSystemPrompt(
    settings.observation.instruction,
    settings.observation.threadTitle,
    { cwd },
  );
  // Local prior observations support dedupe; attributable memories
  // (the cross-session global pack the actor saw) are the only set
  // the observer is allowed to reference back via
  // `usedObservationIds`.
  const previousObservationText = renderPreviousObservationsForObserver(
    previousLocalObservations,
    attributableMemories,
    settings.observation.previousObserverTokens,
  );
  const prompt = buildObserverPrompt(
    trimmedMessages,
    previousObservationText,
    observationLogBudget,
  );
  const result = await generateStructuredOutput({
    model,
    tool: observerResultTool,
    systemPrompt,
    prompt,
    onUsage,
  });
  if (!result.hasMemory) {
    return {
      ...result,
      observations: "",
    };
  }
  const observations = await enforceObservationTokenBudget({
    text: result.observations,
    targetTokens: observationLogBudget,
    retry: async (actualTokens) => {
      const retryResult = await generateStructuredOutput({
        model,
        tool: observerResultTool,
        systemPrompt,
        prompt: buildObserverPrompt(
          trimmedMessages,
          previousObservationText,
          observationLogBudget,
          { actualTokens },
        ),
        onUsage,
      });
      return retryResult.observations;
    },
  });
  return {
    ...result,
    observations,
  };
}

function renderPreviousObservationsForObserver(
  localObservations: Observation[],
  attributableMemories: Observation[],
  budget: number,
): string {
  if (budget <= 0) return "";
  // Render attributable cross-session memories first with explicit id
  // markers so the observer can cite them in `usedObservationIds`.
  // Local-session observations follow without ids — they exist for
  // dedupe context only and the lastUsedAt bump does not apply
  // within the current session anyway (their createdAt is always
  // recent).
  const sections: string[] = [];
  let tokens = 0;
  for (const memory of attributableMemories) {
    const block = `[memory id: ${memory.id}]\n${memory.content}`;
    const next = estimateTokens(block);
    if (tokens + next > budget) break;
    sections.push(block);
    tokens += next;
  }
  const selected: string[] = [];
  for (let index = localObservations.length - 1; index >= 0; index--) {
    const content = localObservations[index]!.content;
    const nextTokens = estimateTokens(content);
    if (tokens + nextTokens > budget) break;
    selected.unshift(content);
    tokens += nextTokens;
  }
  if (selected.length > 0) sections.push(selected.join("\n\n"));
  return sections.join("\n\n");
}

export async function enforceObservationTokenBudget(options: {
  text: string;
  targetTokens: number;
  retry: (actualTokens: number) => Promise<string>;
}): Promise<string> {
  const first = sanitizeObservationLines(options.text.trim());
  const firstTokens = estimateTokens(first);
  if (firstTokens <= options.targetTokens) {
    return first;
  }

  const retried = sanitizeObservationLines((await options.retry(firstTokens)).trim());
  const retriedTokens = estimateTokens(retried);
  if (retriedTokens <= options.targetTokens) {
    return retried;
  }

  return trimObservationTextToTokenBudget(retried, options.targetTokens);
}

export function trimObservationTextToTokenBudget(text: string, targetTokens: number): string {
  if (targetTokens <= 0) return "";
  if (estimateTokens(text) <= targetTokens) return text;

  const targetChars = Math.max(0, targetTokens * 4);
  const marker = "\n… [truncated to fit memory token budget]";
  if (targetChars <= marker.length) {
    return text.slice(0, targetChars).trimEnd();
  }

  const trimmed = text.slice(0, targetChars - marker.length).trimEnd();
  return `${trimmed}${marker}`;
}

/** Smallest partial-message slice worth keeping at the boundary, in characters. */
const MIN_PARTIAL_BOUNDARY_CHARS = 200;
const PARTIAL_BOUNDARY_MARKER = "[… older content trimmed]\n";

/**
 * Trim the oldest end of a raw tail to fit `transcriptBudget`. Whole
 * newest-end messages are kept verbatim; when the budget cuts through
 * a message, that boundary message is included partially — its
 * `textPreview` is sliced to keep the most recent characters that fit,
 * prefixed with a marker so the observer knows the head was dropped.
 * Image blocks on a partial boundary message are dropped since image
 * tokens are charged per-image at a coarse 1.6k-token rate that can't
 * be split.
 *
 * Empty inputs and zero/negative budgets short-circuit to `[]` so the
 * caller can still produce a (now empty) prompt without throwing.
 */
export function trimMessagesToTranscriptBudget(
  messages: RawMemoryMessage[],
  transcriptBudget: number,
): RawMemoryMessage[] {
  if (messages.length === 0) return messages;
  if (transcriptBudget <= 0) return [];
  let runningTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const tokens = message.estimatedTokens ?? estimateTokens(message.textPreview);
    if (runningTokens + tokens <= transcriptBudget) {
      runningTokens += tokens;
      continue;
    }
    const remainingTokens = transcriptBudget - runningTokens;
    const partial = buildPartialBoundaryMessage(message, remainingTokens);
    if (partial) {
      return [partial, ...messages.slice(index + 1)];
    }
    return messages.slice(index + 1);
  }
  return messages;
}

function buildPartialBoundaryMessage(
  message: RawMemoryMessage,
  remainingTokens: number,
): RawMemoryMessage | undefined {
  if (remainingTokens <= 0) return undefined;
  const text = message.textPreview;
  const charBudget = remainingTokens * 4 - PARTIAL_BOUNDARY_MARKER.length;
  if (charBudget < MIN_PARTIAL_BOUNDARY_CHARS) return undefined;
  const sliceLength = Math.min(text.length, charBudget);
  if (sliceLength <= 0) return undefined;
  const truncated = `${PARTIAL_BOUNDARY_MARKER}${text.slice(text.length - sliceLength)}`;
  return {
    ...message,
    textPreview: truncated,
    content: [{ type: "text", text: truncated }],
    estimatedTokens: estimateTokens(truncated),
  };
}

export function getUnobservedMessageTail(
  messages: RawMemoryMessage[],
  observations: Observation[],
): RawMemoryMessage[] {
  const lastObservedIndex = getLastObservedMessageIndex(messages, observations);
  if (lastObservedIndex < 0) {
    return messages;
  }
  return messages.slice(lastObservedIndex + 1);
}

function getLastObservedMessageIndex(
  messages: RawMemoryMessage[],
  observations: Observation[],
): number {
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));
  let lastObservedIndex = -1;

  for (const observation of observations) {
    const groups = parseObservationGroups(observation.content);
    for (const group of groups) {
      // Observation-group ranges are the only progress marker. No-op observer
      // passes do not advance this index, preserving their messages as future
      // context until an actual observation records a range.
      const endId = group.range.split(":").at(-1)?.trim();
      const endIndex = endId ? messageIndexById.get(endId) : undefined;
      if (endIndex !== undefined) {
        lastObservedIndex = Math.max(lastObservedIndex, endIndex);
      }
    }
  }

  return lastObservedIndex;
}

export function agentMessagesToRaw(messages: AgentMessage[]): RawMemoryMessage[] {
  return messages
    .map((message) => agentMessageToRaw(message))
    .filter((message): message is RawMemoryMessage => Boolean(message));
}

export function agentMessageToRaw(message: AgentMessage): RawMemoryMessage | undefined {
  const normalized = serializeMessageForObserver(message);
  if (normalized.textPreview.trim().length === 0) {
    return undefined;
  }
  return {
    id: stableRawMessageId(message, normalized.textPreview),
    createdAt:
      "timestamp" in message && typeof message.timestamp === "number"
        ? message.timestamp
        : Date.now(),
    role: normalizeRole(String(message.role)),
    content: normalized.content,
    textPreview: normalized.textPreview,
    estimatedTokens: estimateMessageTokens(normalized),
  };
}

function stableRawMessageId(
  message: AgentMessage,
  textPreview: string = serializeMessageForObserver(message).textPreview,
): RawMemoryMessage["id"] {
  if (message.role === "assistant" && "responseId" in message && message.responseId) {
    return `msg_assistant_${message.responseId}`;
  }
  if (message.role === "toolResult" && "toolCallId" in message) {
    return `msg_tool_${message.toolCallId}`;
  }
  const timestamp =
    "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return `msg_${String(message.role)}_${timestamp}_${hashText(textPreview)}`;
}

function normalizeRole(role: string): RawMemoryMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  if (role === "toolResult" || role === "toolCall") {
    return "tool";
  }
  return "system";
}

/**
 * Multimodal-preview projection of an `AgentMessage` used exclusively by the
 * observer pipeline. The observer model reads `textPreview` as a transcript
 * and the image blocks in `content` as inline attachments; structured
 * provider blocks (`toolCall`, `thinking`, etc.) are flattened into compact
 * `textPreview` snippets so the observer sees what was called and what came
 * back without paying for the full serialized request body.
 */
interface ObserverMessagePreview {
  content: Array<TextContent | ImageContent>;
  textPreview: string;
}

/**
 * Per-block cap for tool-call arguments and tool-result text. Tool I/O is
 * background context for the observer, not the subject of the observation,
 * so each block is truncated rather than included verbatim. 1,500 chars
 * (~375 tokens) is enough to recognize what was called and what came back
 * while keeping any single tool round-trip from dominating the observer
 * batch budget.
 */
const MAX_TOOL_PREVIEW_CHARS = 1_500;

function truncateForObserver(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} … [truncated]`;
}

/**
 * Project an `AgentMessage` into the compact transcript the observer model
 * consumes. Text and image blocks pass through (text in `textPreview`,
 * image bytes inline in `content`); tool calls are flattened into short
 * `[toolCall name(args)]` snippets, tool-result content is truncated and
 * prefixed with the tool name, and thinking blocks are dropped (see
 * {@link structuredBlockPreview}).
 *
 * Not a wire-faithful round-trip — the actor's request to the provider is
 * built separately. This projection is observer-only, which is why
 * truncation and tagging are safe here.
 */
function serializeMessageForObserver(message: AgentMessage): ObserverMessagePreview {
  const isToolResult = message.role === "toolResult";
  const maybeContent = (message as { content?: unknown }).content;

  if (typeof maybeContent === "string") {
    const text = isToolResult
      ? truncateForObserver(maybeContent, MAX_TOOL_PREVIEW_CHARS)
      : maybeContent;
    return {
      content: [{ type: "text", text }],
      textPreview: prefixToolResult(message, text),
    };
  }
  if (Array.isArray(maybeContent)) {
    const content: Array<TextContent | ImageContent> = [];
    const previews: string[] = [];
    for (const part of maybeContent) {
      if (isTextContent(part)) {
        const text = isToolResult
          ? truncateForObserver(part.text, MAX_TOOL_PREVIEW_CHARS)
          : part.text;
        content.push({ type: "text", text });
        previews.push(text);
        continue;
      }
      if (isImageContent(part)) {
        content.push(part);
        previews.push(imageContentPreview(part));
        continue;
      }
      const preview = structuredBlockPreview(part);
      if (preview) previews.push(preview);
    }
    return {
      content,
      textPreview: prefixToolResult(message, previews.join("\n")),
    };
  }
  if ("summary" in message && typeof message.summary === "string") {
    return {
      content: [{ type: "text", text: message.summary }],
      textPreview: message.summary,
    };
  }
  return { content: [], textPreview: "" };
}

/**
 * Tag tool-result messages with their `toolName` so the observer can match
 * results back to the tool that produced them when grouping observations.
 * The tool-call site already names the tool inline; this keeps the result
 * side symmetrical without relying on positional ordering.
 */
function prefixToolResult(message: AgentMessage, body: string): string {
  if (message.role !== "toolResult") return body;
  const errorTag = message.isError ? " (error)" : "";
  return `[toolResult ${message.toolName}${errorTag}]\n${body}`;
}

function isTextContent(part: unknown): part is TextContent {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isImageContent(part: unknown): part is ImageContent {
  return part !== null && typeof part === "object" && "type" in part && part.type === "image";
}

function imageContentPreview(part: ImageContent): string {
  const record = part as unknown as Record<string, unknown>;
  const details = [imageMediaType(record), imageSourcePreview(record)].filter(
    (detail): detail is string => Boolean(detail),
  );
  return details.length > 0 ? `[image: ${details.join(" ")}]` : "[image]";
}

function imageMediaType(record: Record<string, unknown>): string | undefined {
  return (
    stringField(record, "mediaType") ??
    stringField(record, "mimeType") ??
    stringField(record, "media_type") ??
    sourceMediaType(record.source)
  );
}

function sourceMediaType(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const sourceRecord = source as Record<string, unknown>;
  return (
    stringField(sourceRecord, "mediaType") ??
    stringField(sourceRecord, "mimeType") ??
    stringField(sourceRecord, "media_type")
  );
}

function imageSourcePreview(record: Record<string, unknown>): string | undefined {
  const directUrl = safeImageUrl(stringField(record, "url") ?? stringField(record, "imageUrl"));
  if (directUrl) return `url=${directUrl}`;
  if (stringField(record, "data")) return "source=data omitted";
  const source = record.source;
  if (!source) return undefined;
  if (typeof source === "string") {
    return source.startsWith("data:") ? "source=data omitted" : "source=string";
  }
  if (typeof source !== "object") return undefined;
  const sourceRecord = source as Record<string, unknown>;
  const sourceType = stringField(sourceRecord, "type");
  const sourceUrl = safeImageUrl(stringField(sourceRecord, "url"));
  if (sourceUrl) return `url=${sourceUrl}`;
  if (sourceType) return `source=${sourceType} omitted`;
  return "source=object omitted";
}

function safeImageUrl(value: string | undefined): string | undefined {
  if (!value || value.startsWith("data:")) return undefined;
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Render a non-text/image provider block as a compact tagged snippet for the
 * observer transcript. Only `toolCall` blocks carry observable signal here —
 * they're rendered as `name(truncated-args)` so the observer can ground
 * observations in what the agent actually invoked. `thinking` blocks are
 * dropped intentionally: the observer should record what was decided, not
 * the assistant's intermediate reasoning, and rolling thinking into the
 * transcript would only crowd the batch budget. Other unknown structured
 * types fall back to a typed placeholder.
 */
function structuredBlockPreview(part: unknown): string | undefined {
  if (!part || typeof part !== "object" || !("type" in part)) {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  if (type === "thinking") return undefined;
  if (type === "toolCall") {
    const name = stringField(record, "name") ?? "unknown";
    const args = record.arguments ?? {};
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = "{}";
    }
    return `[toolCall ${name}(${truncateForObserver(serialized, MAX_TOOL_PREVIEW_CHARS)})]`;
  }
  const id = stringField(record, "id");
  const name = stringField(record, "name");
  return `[${[type, id, name].filter(Boolean).join(": ")}]`;
}

const MAX_OBSERVATION_LINE_CHARS = 10_000;

export function sanitizeObservationLines(observations: string): string {
  if (!observations) return observations;
  let changed = false;
  const lines = observations.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > MAX_OBSERVATION_LINE_CHARS) {
      lines[i] = lines[i]!.slice(0, MAX_OBSERVATION_LINE_CHARS) + " … [truncated]";
      changed = true;
    }
  }
  return changed ? lines.join("\n") : observations;
}

function inferPriority(observations: string): ObservationPriority {
  if (observations.includes("🔴") || observations.includes("✅")) return "high";
  if (observations.includes("🟡")) return "medium";
  return "low";
}

function estimateMessageTokens(message: ObserverMessagePreview): number {
  const imageTokens =
    message.content.filter((part) => part.type === "image").length * IMAGE_WIRE_TOKEN_ESTIMATE;
  return estimateTokens(message.textPreview) + imageTokens;
}

/**
 * Average characters per token assumed by the heuristic estimator. The
 * common rule of thumb is ~4 chars/token on English prose, but real
 * provider tokenizers consistently produce more tokens than that on
 * code, JSON, tool calls, and non-English content. We use 3.2 to bias
 * the estimate ~25 % conservative so memory triggers fire before the
 * provider's actual token count crosses the actor's window, instead of
 * after.
 */
export const CHARS_PER_TOKEN = 3.2;

/**
 * Heuristic chars-per-token estimator used everywhere the runner needs
 * a budget number without tokenizing the actual provider payload. Exported
 * so surfaces and the runner can attribute the same estimate the memory
 * pipeline does, keeping the segment breakdown on `TurnUsageFields`
 * consistent with the trigger arithmetic in this file.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
