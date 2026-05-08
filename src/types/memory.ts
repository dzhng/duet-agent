/** Relative importance used for recall ordering and prompt rendering. */
export type ObservationPriority = "high" | "medium" | "low";

/** Whether an observation belongs to current turn-runner memory or a reusable resource. */
export type ObservationScope = "session" | "resource";

/** Reflection policy for condensing accumulated observations. */
export type ReflectionMode = "none" | "threshold" | "forced";

/** Where an observation came from, used for auditability and future filtering. */
export type ObservationSource =
  | { kind: "user" }
  /** Produced by an agent; name is optional because the runner does not assign agent ids. */
  | { kind: "agent"; name?: string }
  | { kind: "system" }
  /** Produced from a specific tool call or tool result. */
  | { kind: "tool"; toolName: string };

/** Durable memory rendered back into model context after raw messages compact. */
export interface Observation {
  /** Stable persistence key for the observation row. */
  id: string;
  /** Unix timestamp in milliseconds when this observation was stored. */
  createdAt: number;
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
  /** Scope controls whether this memory is session-local or reusable across resources. */
  scope: ObservationScope;
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
}

/** Runtime settings for converting turn-runner conversation context into observations. */
export interface ObservationalMemorySettings {
  /** Scope assigned to newly generated observations. */
  scope: ObservationScope;
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
  /** Future retrieval behavior; vector search becomes useful once embeddings are stored. */
  retrieval?: boolean | { vector?: boolean; scope?: ObservationScope };
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

/** Query used by MemoryStore.recall to filter and rank observations. */
export interface ObservationQuery {
  /** Text query for simple lexical ranking. */
  query?: string;
  /** Return observations matching at least one of these tags. */
  tags?: string[];
  /** Restrict recall to session or resource-scoped observations. */
  scope?: ObservationScope;
  /** Maximum number of observations to return. */
  limit?: number;
  /** Minimum priority to include. */
  minPriority?: ObservationPriority;
}

/** Events emitted by MemoryStore for external persistence. */
export type MemoryStoreEvent =
  /** A new observation was added without replacing the full memory set. */
  | { type: "observation_appended"; observation: Observation }
  /** The complete observation set was replaced, usually after reflection. */
  | { type: "observations_replaced"; observations: Observation[] };

/** Subscription callback for MemoryStore changes. */
export type MemoryStoreEventHandler = (event: MemoryStoreEvent) => void;
