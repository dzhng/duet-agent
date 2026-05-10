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

/** Runtime settings for converting turn-runner conversation context into observations. */
export interface ObservationalMemorySettings {
  /** Settings for extracting new observations from raw agent messages. */
  observation: {
    /** Raw-message token threshold that triggers replacing old transcript context. */
    messageTokens: number;
    /** Maximum raw-message tokens to send to one observer call. */
    maxTokensPerBatch: number;
    /** Raw-message token budget retained when context replacement is needed. */
    bufferActivation: number;
    /** Optional hard stop for observation work after a caller-defined threshold. */
    blockAfter?: number;
    /** Optional budget for including previous observations in observer prompts. */
    previousObserverTokens?: number | false;
    /** Additional instructions appended to the observer system prompt. */
    instruction?: string;
    /** Whether the observer should also produce a short thread title. */
    threadTitle?: boolean;
  };
  /** Settings for condensing the durable observation log. */
  reflection: {
    /** Observation token threshold that triggers reflection. */
    observationTokens: number;
    /** Observation token budget to target after reflection condenses the log. */
    bufferActivation: number;
    /** Optional hard stop for reflection work after a caller-defined threshold. */
    blockAfter?: number;
    /** Additional instructions appended to the reflector system prompt. */
    instruction?: string;
  };
  /**
   * Token budget for the global memory layer rendered ahead of the local
   * session's compacted view. Cross-session reflections and observations
   * are ranked by `priority * usageDecay * kindBias` and packed greedily
   * until this budget is exhausted. Local memory has no separate budget —
   * it reuses the existing `observation` and `reflection` thresholds since
   * the local layer is just the current session's compaction output.
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
  /** Whether memory should share the actor context budget instead of using its own thresholds. */
  shareTokenBudget: boolean;
  /** Whether prompts should include explicit date/time markers for temporal reasoning. */
  temporalMarkers: boolean;
  /** Optional idle duration before activating observation work. */
  activateAfterIdle?: number;
  /** Whether provider/model changes should force observation activation. */
  activateOnProviderChange: boolean;
}

/**
 * Caller-provided memory settings. Nested observation and reflection settings
 * are partial because callers commonly override only thresholds or instructions
 * while leaving the rest of the runtime defaults intact.
 */
export type ObservationalMemorySettingsInput = Partial<
  Omit<ObservationalMemorySettings, "observation" | "reflection">
> & {
  observation?: Partial<ObservationalMemorySettings["observation"]>;
  reflection?: Partial<ObservationalMemorySettings["reflection"]>;
};
