import type { Model } from "@mariozechner/pi-ai";
import type { MemoryStore } from "../memory/store.js";
import type { AgentId, MemoryId, SessionId } from "./identity.js";

export type ObservationPriority = "high" | "medium" | "low";
export type ObservationScope = "session" | "resource";
export type ReflectionMode = "none" | "threshold" | "forced";

export type ObservationSource =
  | { kind: "user" }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "system" }
  | { kind: "tool"; toolName: string };

/** Durable memory rendered back into model context after raw messages compact. */
export interface Observation {
  id: MemoryId;
  sessionId: SessionId;
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

/** Text serialization of an AgentMessage retained until observation activation. */
export interface RawMemoryMessage {
  id: MemoryId;
  sessionId: SessionId;
  createdAt: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  estimatedTokens?: number;
}

/** Complete memory view callers can persist and pass back into Harness.run for restore. */
export interface ObservationalMemorySnapshot {
  sessionId: SessionId;
  observations: Observation[];
  rawMessages: RawMemoryMessage[];
  estimatedTokens: {
    observations: number;
    rawMessages: number;
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
  sessionId?: SessionId;
  query?: string;
  tags?: string[];
  scope?: ObservationScope;
  limit?: number;
  minPriority?: ObservationPriority;
}

export type MemoryStoreEvent =
  | { type: "raw_message_appended"; message: RawMemoryMessage }
  | { type: "observation_appended"; observation: Observation }
  | { type: "raw_messages_replaced"; sessionId: SessionId; messages: RawMemoryMessage[] }
  | { type: "observations_replaced"; sessionId: SessionId; observations: Observation[] };

export type MemoryStoreEventHandler = (event: MemoryStoreEvent) => void;

/** Persistence modules hydrate MemoryStore before a run and subscribe to changes. */
export interface MemoryPersistenceModule {
  load?(store: MemoryStore): void | Promise<void>;
  subscribe?(store: MemoryStore): void | (() => void);
}
