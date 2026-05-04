import type { Model } from "@mariozechner/pi-ai";

export type ObservationPriority = "high" | "medium" | "low";
export type ObservationScope = "session" | "resource";
export type ReflectionMode = "none" | "threshold" | "forced";

export type ObservationSource =
  | { kind: "user" }
  | { kind: "agent"; name?: string }
  | { kind: "system" }
  | { kind: "tool"; toolName: string };

/** Durable memory rendered back into model context after raw messages compact. */
export interface Observation {
  id: string;
  createdAt: number;
  observedDate: string;
  referencedDate?: string;
  relativeDate?: string;
  timeOfDay?: string;
  priority: ObservationPriority;
  scope: ObservationScope;
  source: ObservationSource;
  content: string;
  tags: string[];
}

/** Complete durable memory view persisted outside the harness run. */
export interface ObservationalMemorySnapshot {
  observations: Observation[];
  estimatedTokens: {
    observations: number;
  };
  updatedAt: number;
}

export interface ObservationalMemorySettings {
  enabled: boolean;
  scope: ObservationScope;
  model?: Model<any>;
  observation: {
    model?: Model<any>;
    messageTokens: number;
    maxTokensPerBatch: number;
    bufferActivation: number;
    blockAfter?: number;
    previousObserverTokens?: number | false;
    instruction?: string;
    threadTitle?: boolean;
  };
  reflection: {
    model?: Model<any>;
    observationTokens: number;
    bufferActivation: number;
    blockAfter?: number;
    instruction?: string;
  };
  retrieval?: boolean | { vector?: boolean; scope?: ObservationScope };
  shareTokenBudget: boolean;
  temporalMarkers: boolean;
  activateAfterIdle?: number;
  activateOnProviderChange: boolean;
}

export interface ObservationQuery {
  query?: string;
  tags?: string[];
  scope?: ObservationScope;
  limit?: number;
  minPriority?: ObservationPriority;
}

export type MemoryStoreEvent =
  | { type: "observation_appended"; observation: Observation }
  | { type: "observations_replaced"; observations: Observation[] };

export type MemoryStoreEventHandler = (event: MemoryStoreEvent) => void;
