/** Relative importance used for recall ordering and prompt rendering. */
export type ObservationPriority = "high" | "medium" | "low";

/**
 * Whether a row is a raw observation or a reflection synthesized by the
 * reflector. Reflections rank higher by default (see `reflectionBias`)
 * because they are condensed cross-observation summaries that survived a
 * curation pass; the loader prefers them when the global budget tightens.
 */
export type ObservationKind = "observation" | "reflection";

/**
 * Where an observation came from. Used for auditability and downstream
 * filtering. Tool provenance is captured as `tool:<name>` in `tags`
 * rather than a separate variant — keeps the source enum closed and
 * makes tool authorship searchable through the existing tag axis.
 */
export type ObservationSource =
  | { kind: "user" }
  /** Produced by an agent; name is optional because the runner does not assign agent ids. */
  | { kind: "agent"; name?: string }
  | { kind: "system" };

/** Durable memory rendered back into model context after raw messages compact. */
export interface Observation {
  /** Stable persistence key for the observation row. */
  id: string;
  /** Unix timestamp in milliseconds when this observation was stored. */
  createdAt: number;
  /**
   * Unix timestamp in milliseconds for the most recent turn that
   * actually used this observation. Initialized to `createdAt` and
   * advanced when the observer reports the row as having informed an
   * assistant response (`usedObservationIds`). Drives the global-layer
   * ranking decay so memories that keep getting used keep surfacing,
   * regardless of how old they originally are.
   */
  lastUsedAt: number;
  /**
   * Session that produced this observation. Optional only for rows that
   * predate sessionId tracking — new writes always set it. Loaders use
   * this as the local/global axis: rows whose sessionId matches the
   * current runner are local (always rendered), everything else is
   * global (ranked into a fixed token budget).
   */
  sessionId?: string;
  /**
   * Whether this row is a raw observation or a reflection. The reflector
   * replaces a batch of observations with a single condensed reflection;
   * downstream ranking gives reflections a multiplier to match their
   * higher signal-per-token.
   */
  kind: ObservationKind;
  /** Calendar date the observation is anchored to, usually the day it was observed. */
  observedDate: string;
  /** Concrete date mentioned by the user or tool output when different from observedDate. */
  referencedDate?: string;
  /** Original relative date phrase, such as "tomorrow" or "last week", when useful. */
  relativeDate?: string;
  /** 24-hour local time attached to the observation, when available. */
  timeOfDay?: string;
  /** Importance signal used by recall and context rendering. */
  priority: ObservationPriority;
  /** Origin of the observation for debugging, filtering, and future trust policies. */
  source: ObservationSource;
  /** The actual memory text that can be rendered back into model context. */
  content: string;
  /** Lightweight labels for filtering, grouping, and persistence queries. */
  tags: string[];
}

/** Complete durable memory view persisted outside the runner state. */
export interface ObservationalMemorySnapshot {
  /** All durable observations currently owned by the runner memory store. */
  observations: Observation[];
  /** Approximate token counts used to decide when observation/reflection should execute. */
  estimatedTokens: {
    /** Approximate tokens for all observation content. */
    observations: number;
  };
  /** Unix timestamp in milliseconds for when this snapshot was produced. */
  updatedAt: number;
}

/** Progress/result update emitted while observational memory work runs during a turn. */
export interface ObservationalMemoryActivityEvent {
  /** Memory operation currently processing the latest pi-agent transcript boundary. */
  phase: "observation" | "reflection";
  /** Whether the operation is still running or has finished. */
  status: "running" | "completed";
  /** Human-readable status suitable for CLI/TUI surfaces. */
  message: string;
  /** Durable observations produced or replaced by a completed memory operation. */
  observations?: Observation[];
  /**
   * Prior global-pack memories whose `lastUsedAt` was advanced because the
   * observer attributed the latest exchange to them. Only set on the
   * `observation` phase completion event, where usage attribution runs.
   * Empty/undefined means no prior memory was reused on this turn. Carries
   * the full observation rows (not just ids) so surfaces can render the
   * reused content directly without a second database lookup.
   */
  usageBumpedObservations?: Observation[];
}

/**
 * Fully resolved memory settings consumed by the observational pipeline.
 *
 * All numeric token budgets are derived once from
 * `TurnRunnerConfig.effectiveContext` by `deriveMemoryBudgets` in
 * `src/memory/observational.ts` and merged with the user-settable
 * non-budget knobs by `resolveObservationalMemorySettings`. See
 * `MEMORY_BUDGET_RATIOS` for the derivation table.
 */
export interface ObservationalMemorySettings {
  /** Settings for extracting new observations from raw agent messages. */
  observation: {
    /**
     * Derived. Raw-message token threshold (per turn) that triggers
     * replacing old transcript content via the wire-shaping horizon.
     * `0.60 * effectiveContext`.
     */
    messageTokens: number;
    /**
     * Derived (fixed constant). Cap on raw transcript tokens sent to one
     * observer call. Independent of `effectiveContext` because reflection
     * quality depends on a consistent observer-call window, not on the
     * user's actor budget.
     */
    maxTokensPerBatch: number;
    /**
     * Derived. Raw-tail token target after the wire-shaping horizon
     * advances. `BUFFER_RATIO * messageTokens`. Does not count against
     * `effectiveContext` since it is bounded above by `messageTokens`,
     * which already counts.
     */
    bufferActivation: number;
    /**
     * Derived (fixed constant). Budget for including previous observations
     * as dedupe context in observer prompts. Observer-only; never enters
     * the actor's context window.
     */
    previousObserverTokens: number;
    /** Additional instructions appended to the observer system prompt. */
    instruction?: string;
    /** Whether the observer should also produce a short thread title. */
    threadTitle?: boolean;
  };
  /** Settings for condensing the durable observation log. */
  reflection: {
    /**
     * Derived. Local-memory token ceiling between reflections; reflection
     * fires once the current session's observations grow past this.
     * `0.325 * effectiveContext`.
     */
    observationTokens: number;
    /**
     * Derived. Local-memory token target after a reflection event.
     * `BUFFER_RATIO * observationTokens`. Does not count against
     * `effectiveContext` since it is bounded above by `observationTokens`.
     */
    bufferActivation: number;
    /** Additional instructions appended to the reflector system prompt. */
    instruction?: string;
  };
  /**
   * Derived. Token budget for the global memory layer rendered ahead of
   * the local session's compacted view. Cross-session reflections and
   * observations are ranked by `priority * usageDecay * kindBias` and
   * packed greedily until this budget is exhausted. `0.075 * effectiveContext`.
   */
  globalContextTokenBudget: number;
  /**
   * Half-life applied to time since `lastUsedAt` in the global-layer
   * ranking. `usageDecay = 0.5 ^ ((now - lastUsedAt) / halfLifeMs)` —
   * at one half-life since last use a row is worth half what a
   * just-used row of the same priority is worth. Default 7 days:
   * short enough that month-old unused chatter stops crowding out
   * current week's decisions, long enough that yesterday's
   * conclusions still surface tomorrow. Ranking is a monotone
   * function of `lastUsedAt`, so the ordering between any two rows
   * is invariant to `now` within a single ranking pass — the loader
   * exploits this to push the entire ORDER BY into SQL.
   */
  recencyHalfLifeMs: number;
  /**
   * Multiplier applied to a row's score when it is a reflection rather
   * than a raw observation. Default 1.3 keeps reflections preferred at
   * matched priority/recency without completely shutting raw
   * observations out of the global pack.
   */
  reflectionBias: number;
  /** Whether the recall_memory tool and embedding backfill are enabled. */
  retrieval: boolean;
}

/**
 * Caller-provided memory settings. Only non-budget knobs are user-settable:
 * every numeric token budget is derived from
 * `TurnRunnerConfig.effectiveContext` and cannot be pinned individually.
 */
export interface ObservationalMemorySettingsInput {
  observation?: {
    /** Additional instructions appended to the observer system prompt. */
    instruction?: string;
    /** Whether the observer should also produce a short thread title. */
    threadTitle?: boolean;
  };
  reflection?: {
    /** Additional instructions appended to the reflector system prompt. */
    instruction?: string;
  };
  /** Half-life for the global-layer recency decay; see `ObservationalMemorySettings.recencyHalfLifeMs`. */
  recencyHalfLifeMs?: number;
  /** Reflection-vs-observation score multiplier; see `ObservationalMemorySettings.reflectionBias`. */
  reflectionBias?: number;
  /** Whether the recall_memory tool and embedding backfill are enabled. */
  retrieval?: boolean;
}
