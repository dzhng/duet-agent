import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
import {
  applyEvictionHorizon,
  calculateWireBytes,
  findEvictionHorizon,
  WIRE_BYTE_TARGET,
  WIRE_BYTE_TRIGGER,
  type WireGuardHorizon,
} from "../turn-runner/wire-shaping.js";
import type { MemoryContextCache } from "./store.js";
import {
  appendObservation,
  bumpLastUsed,
  readSessionObservations,
  replaceSessionObservations,
  type MemoryDatabase,
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
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  type RawMemoryMessage,
} from "./observational-prompts.js";

export const OBSERVATIONAL_MEMORY_DEFAULTS = {
  // Token budget for the global memory layer rendered ahead of message
  // history. Sized to fit the highest-signal cross-session reflections
  // without crowding out the local layer or message tail. See
  // ObservationalMemorySettings.globalContextTokenBudget for the full
  // rationale.
  globalContextTokenBudget: 8_000,
  // 7 days picked to keep last-week's context current while letting
  // month-old chatter decay out of the global pack. Tunable per-caller.
  recencyHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
  // 1.3 keeps reflections preferred at matched priority/recency without
  // shutting raw observations out of the global pack entirely.
  reflectionBias: 1.3,
  observation: {
    // Observe before the actor window gets tight; prompt caching keeps the exact
    // tail cheap while memory preserves older task state.
    messageTokens: 100_000,
    // Keep observer calls comfortably below the model's practical reasoning
    // ceiling while still batching enough transcript to avoid noisy churn.
    maxTokensPerBatch: 35_000,
    // Retain enough exact history for active tool work after older messages are
    // represented by observations.
    bufferActivation: 30_000,
    // Existing observations help avoid semantic duplicates, but the observer
    // should never receive the whole durable memory database.
    previousObserverTokens: 4_000,
  },
  reflection: {
    // Reflect before observations become a second large prompt layer.
    observationTokens: 60_000,
    // Target this many observation tokens after reflection so the pass dedupes
    // without aggressively summarizing away useful specifics.
    bufferActivation: 40_000,
  },
} as const;

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

export interface ReflectorResult {
  /** Condensed observation log produced from existing observations. */
  observations: string;
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
        "Ids of prior memories from the [memory id: mem_...] markers in the existing observations block whose content actually informed the assistant's response in this exchange. Drives the lastUsedAt freshness signal so reused memories keep surfacing. Omit or return [] when no prior memory was leaned on.",
    }),
  ),
  currentTask: Type.Optional(
    Type.String({ description: "Current task state distilled for continuity." }),
  ),
  suggestedContinuation: Type.Optional(
    Type.String({ description: "Hint for the actor's next response after context compression." }),
  ),
  threadTitle: Type.Optional(
    Type.String({ description: "Short 2-5 word title when thread title generation is requested." }),
  ),
});

const observerResultTool = {
  name: "recordObservations",
  description: "Return extracted observational memory fields.",
  parameters: observerResultSchema,
};

const reflectorResultSchema = Type.Object({
  observations: Type.String({
    description:
      "Condensed observation log preserving important facts, dates, preferences, unresolved work, and completion markers.",
  }),
  suggestedContinuation: Type.Optional(
    Type.String({
      description: "Hint for the actor's next response after reflection rewrites memory.",
    }),
  ),
});

const reflectorResultTool = {
  name: "reflectObservations",
  description: "Return condensed observational memory fields.",
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
  settings?: ObservationalMemorySettingsInput;
  /**
   * Compaction trigger fired when the wire-shaping eviction horizon
   * advances mid-turn. The runner uses it to rebuild the frozen memory
   * context pack — the prompt cache is already invalidating because
   * eviction changed the message tail, so refreshing the prefix at the
   * same moment piggybacks on a cache miss the model is already paying.
   */
  onCompaction?: () => void;
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
  /** PGlite database that owns the durable memory rows. */
  db: MemoryDatabase;
  /** Frozen context-pack cache; queried for the global memories the observer can attribute usage against. */
  memory: MemoryContextCache;
  /**
   * Session that owns the runner. Stamped onto every observation and
   * reflection produced by this update so the loader can later split
   * memory into the current session's local layer and every other
   * session's global layer.
   */
  sessionId?: string;
  settings?: ObservationalMemorySettingsInput;
  actorModel: string;
  messages: AgentMessage[];
  onUsage?: (usage: Usage) => void;
  onActivity?: (event: ObservationalMemoryActivityEvent) => void;
}

export interface ObservationalMemoryUpdateResult {
  observations: Observation[];
  reflections: Observation[];
}

export function resolveObservationalMemorySettings(
  input?: ObservationalMemorySettingsInput,
): ObservationalMemorySettings {
  const partial = input ?? {};

  return {
    globalContextTokenBudget:
      partial.globalContextTokenBudget ?? OBSERVATIONAL_MEMORY_DEFAULTS.globalContextTokenBudget,
    recencyHalfLifeMs: partial.recencyHalfLifeMs ?? OBSERVATIONAL_MEMORY_DEFAULTS.recencyHalfLifeMs,
    reflectionBias: partial.reflectionBias ?? OBSERVATIONAL_MEMORY_DEFAULTS.reflectionBias,
    observation: {
      messageTokens:
        partial.observation?.messageTokens ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.messageTokens,
      maxTokensPerBatch:
        partial.observation?.maxTokensPerBatch ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.maxTokensPerBatch,
      bufferActivation:
        partial.observation?.bufferActivation ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.bufferActivation,
      blockAfter: partial.observation?.blockAfter,
      previousObserverTokens:
        partial.observation?.previousObserverTokens ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.previousObserverTokens,
      instruction: partial.observation?.instruction,
      threadTitle: partial.observation?.threadTitle,
    },
    reflection: {
      observationTokens:
        partial.reflection?.observationTokens ??
        OBSERVATIONAL_MEMORY_DEFAULTS.reflection.observationTokens,
      bufferActivation:
        partial.reflection?.bufferActivation ??
        OBSERVATIONAL_MEMORY_DEFAULTS.reflection.bufferActivation,
      blockAfter: partial.reflection?.blockAfter,
      instruction: partial.reflection?.instruction,
    },
    retrieval: partial.retrieval ?? true,
    shareTokenBudget: partial.shareTokenBudget ?? false,
    temporalMarkers: partial.temporalMarkers ?? false,
    activateAfterIdle: partial.activateAfterIdle,
    activateOnProviderChange: partial.activateOnProviderChange ?? false,
  };
}

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
  const settings = resolveObservationalMemorySettings(options.settings);
  validateObservationalMemorySettings(settings);

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const observableMessages = stripObservationalContextMessages(messages);
    let retainedMessages = applyEvictionHorizon(
      observableMessages,
      options.horizon.evictionHorizon,
    );

    // Trigger condition: either budget exceeded under the current sticky
    // horizon. Token budget protects context window cost on smaller models;
    // byte budget protects gateway request-body caps. Eviction advances the
    // horizon enough to satisfy both targets in one block so the next
    // several turns grow back without retriggering.
    const candidateTokens = estimateRawTokens(agentMessagesToRaw(retainedMessages));
    const candidateBytes = calculateWireBytes(retainedMessages);
    const tokenTrigger = settings.observation.messageTokens;
    const tokenTarget = settings.observation.bufferActivation;

    if (candidateTokens >= tokenTrigger || candidateBytes >= WIRE_BYTE_TRIGGER) {
      const previousHorizon = options.horizon.evictionHorizon;
      options.horizon.evictionHorizon = findEvictionHorizon(
        observableMessages,
        options.horizon.evictionHorizon,
        (candidate) => {
          const tokens = estimateRawTokens(agentMessagesToRaw(candidate));
          const bytes = calculateWireBytes(candidate);
          return tokens <= tokenTarget && bytes <= WIRE_BYTE_TARGET;
        },
      );
      retainedMessages = applyEvictionHorizon(observableMessages, options.horizon.evictionHorizon);
      // Compaction trigger: piggyback on the cache miss the eviction
      // already forced. The handler is fire-and-forget; the runner
      // wires it to refresh the frozen memory pack in the background.
      if (options.horizon.evictionHorizon !== previousHorizon) {
        options.onCompaction?.();
      }
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
        "### Long-term memory (cross-session)",
        pack.global.map((observation) => observation.content).join("\n\n"),
      ].join("\n\n"),
    );
  }
  if (pack.local.length > 0) {
    sections.push(
      [
        "### From this session",
        pack.local.map((observation) => observation.content).join("\n\n"),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

export async function updateObservationalMemory(
  options: ObservationalMemoryUpdateOptions,
): Promise<ObservationalMemoryUpdateResult> {
  const settings = resolveObservationalMemorySettings(options.settings);
  validateObservationalMemorySettings(settings);
  const rawMessages = agentMessagesToRaw(stripObservationalContextMessages(options.messages));
  // Local snapshot is the only set whose range markers gate
  // `getUnobservedMessageTail`. The observer's prior-context input
  // includes both this and the global pack rendered with id markers
  // so the model can attribute usage back to specific cross-session
  // memories.
  const localSnapshot = options.sessionId
    ? await readSessionObservations(options.db, options.sessionId)
    : { observations: [], estimatedObservationTokens: 0 };
  const globalPack = options.memory.getContextPack().global;
  const unobservedMessages = getUnobservedMessageTail(rawMessages, localSnapshot.observations);
  const result: ObservationalMemoryUpdateResult = { observations: [], reflections: [] };

  if (unobservedMessages.length > 0) {
    emitMemoryActivity(options.onActivity, {
      phase: "observation",
      status: "running",
      message: "Observing conversation into memory...",
    });
    const { observation, usageBumped } = await activateObservations({
      db: options.db,
      messages: unobservedMessages,
      previousLocalObservations: localSnapshot.observations,
      attributableMemories: globalPack,
      settings,
      sessionId: options.sessionId,
      model: options.actorModel,
      onUsage: options.onUsage,
    });
    if (observation) {
      result.observations.push(observation);
    }
    emitMemoryActivity(options.onActivity, {
      phase: "observation",
      status: "completed",
      message: buildObservationCompletedMessage(observation, usageBumped.length),
      ...(observation ? { observations: [observation] } : {}),
      ...(usageBumped.length > 0 ? { usageBumpedObservations: usageBumped } : {}),
    });
  }

  if (options.sessionId) {
    const refreshed = await readSessionObservations(options.db, options.sessionId);
    if (refreshed.estimatedObservationTokens >= settings.reflection.observationTokens) {
      emitMemoryActivity(options.onActivity, {
        phase: "reflection",
        status: "running",
        message: "Reflecting memory observations...",
      });
      const reflections = await reflectObservations({
        db: options.db,
        sessionObservations: refreshed.observations,
        settings,
        sessionId: options.sessionId,
        model: options.actorModel,
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
  // Surface the count for now; consumers can later render the full
  // observation contents from `usageBumpedObservations` on the event.
  return `${base} Bumped last-use on ${usageBumpedCount} prior ${noun}.`;
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

function stripObservationalContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isObservationalContextMessage(message));
}

function isObservationalContextMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const text = normalizeMessageContent(message).textPreview.trim();
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
  db: MemoryDatabase;
  messages: RawMemoryMessage[];
  /** Prior observations from the same session, used for dedupe context. */
  previousLocalObservations: Observation[];
  /** Cross-session memories rendered to the actor; the observer attributes usage against these. */
  attributableMemories: Observation[];
  settings: ObservationalMemorySettings;
  sessionId: string | undefined;
  model: string;
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
    args.onUsage,
  );
  // Usage attribution applies whether or not the observer had new
  // memory worth recording — a turn can lean on a prior memory even
  // when nothing new is durable.
  const usageBumped = await applyUsageBumps(
    args.db,
    args.attributableMemories,
    observations.usedObservationIds,
  );

  if (!observations.hasMemory || !observations.observations.trim()) {
    // The same low-signal messages may become useful context for a
    // later suffix, so do not record an empty checkpoint.
    return { usageBumped };
  }

  const range = `${args.messages[0]?.id ?? "unknown"}:${args.messages[args.messages.length - 1]?.id ?? "unknown"}`;
  const observation = await appendObservation(args.db, {
    kind: "observation",
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: inferPriority(observations.observations),
    source: { kind: "system" },
    content: wrapInObservationGroup(observations.observations, range),
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
  db: MemoryDatabase,
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
    db,
    validated.map((observation) => observation.id),
    Date.now(),
  );
  return validated;
}

interface ReflectObservationsArgs {
  db: MemoryDatabase;
  sessionObservations: Observation[];
  settings: ObservationalMemorySettings;
  sessionId: string;
  model: string;
  onUsage?: (usage: Usage) => void;
}

async function reflectObservations(
  args: ReflectObservationsArgs,
): Promise<Observation[] | undefined> {
  const { db, sessionObservations, settings, sessionId, model, onUsage } = args;
  const source = sessionObservations.map((observation) => observation.content).join("\n\n");
  const rendered = renderObservationGroupsForReflection(source) ?? source;
  const targetTokens = settings.reflection.bufferActivation;
  const result = await generateStructuredOutput({
    model,
    tool: reflectorResultTool,
    systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction),
    prompt: buildReflectorPrompt(rendered, targetTokens),
    onUsage,
  });
  const text = await enforceObservationTokenBudget({
    text: result.observations,
    targetTokens,
    retry: async (actualTokens) => {
      const retryResult = await generateStructuredOutput({
        model,
        tool: reflectorResultTool,
        systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction),
        prompt: buildReflectorPrompt(rendered, targetTokens, { actualTokens }),
        onUsage,
      });
      return retryResult.observations;
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
  await replaceSessionObservations(db, sessionId, [reflected]);
  return [reflected];
}

async function observe(
  messages: RawMemoryMessage[],
  previousLocalObservations: Observation[],
  attributableMemories: Observation[],
  settings: ObservationalMemorySettings,
  model: string,
  onUsage?: (usage: Usage) => void,
): Promise<ObserverResult> {
  const targetTokens = settings.observation.maxTokensPerBatch;
  const systemPrompt = buildObserverSystemPrompt(
    settings.observation.instruction,
    settings.observation.threadTitle,
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
  const prompt = buildObserverPrompt(messages, previousObservationText, targetTokens);
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
    targetTokens,
    retry: async (actualTokens) => {
      const retryResult = await generateStructuredOutput({
        model,
        tool: observerResultTool,
        systemPrompt,
        prompt: buildObserverPrompt(messages, previousObservationText, targetTokens, {
          actualTokens,
        }),
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
  tokenBudget: number | false | undefined,
): string {
  if (tokenBudget === false || tokenBudget === 0) return "";
  const budget = tokenBudget ?? OBSERVATIONAL_MEMORY_DEFAULTS.observation.previousObserverTokens;
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
  const normalized = normalizeMessageContent(message);
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
  textPreview: string = normalizeMessageContent(message).textPreview,
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

interface NormalizedMessageContent {
  content: Array<TextContent | ImageContent>;
  textPreview: string;
}

// Conservative cross-provider fallback when image dimensions are unavailable.
// Claude's standard vision models cap near 1,568 tokens per image, while OpenAI
// high-detail images can grow by 512px tiles; use a rounded budget so images
// create context pressure even when the raw bytes are omitted from previews.
const ESTIMATED_IMAGE_TOKENS = 1_600;

function normalizeMessageContent(message: AgentMessage): NormalizedMessageContent {
  const maybeContent = (message as { content?: unknown }).content;
  if (typeof maybeContent === "string") {
    return {
      content: [{ type: "text", text: maybeContent }],
      textPreview: maybeContent,
    };
  }
  if (Array.isArray(maybeContent)) {
    const content: Array<TextContent | ImageContent> = [];
    const previews: string[] = [];
    for (const part of maybeContent) {
      if (isTextContent(part)) {
        content.push(part);
        previews.push(part.text);
        continue;
      }
      if (isImageContent(part)) {
        content.push(part);
        previews.push(imageContentPreview(part));
        continue;
      }
      const preview = unsupportedContentPreview(part);
      if (preview) previews.push(preview);
    }
    return {
      content,
      textPreview: previews.join("\n"),
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

function unsupportedContentPreview(part: unknown): string | undefined {
  if (!part || typeof part !== "object" || !("type" in part)) {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
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

function estimateRawTokens(messages: RawMemoryMessage[]): number {
  return messages.reduce(
    (total, message) => total + (message.estimatedTokens ?? estimateTokens(message.textPreview)),
    0,
  );
}

function estimateMessageTokens(message: NormalizedMessageContent): number {
  const imageTokens =
    message.content.filter((part) => part.type === "image").length * ESTIMATED_IMAGE_TOKENS;
  return estimateTokens(message.textPreview) + imageTokens;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
