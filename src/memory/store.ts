import { createMemoryId, type MemoryId, type SessionId } from "../types/identity.js";
import type {
  MemoryStoreEvent,
  MemoryStoreEventHandler,
  Observation,
  ObservationPriority,
  ObservationQuery,
  ObservationalMemorySnapshot,
  RawMemoryMessage,
} from "../types/memory.js";

export class MemoryStore {
  private observations: Map<MemoryId, Observation> = new Map();
  private rawMessages: Map<MemoryId, RawMemoryMessage> = new Map();
  private handlers = new Set<MemoryStoreEventHandler>();

  on(handler: MemoryStoreEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async appendRawMessage(
    input: Omit<RawMemoryMessage, "id" | "createdAt">,
  ): Promise<RawMemoryMessage> {
    const message: RawMemoryMessage = {
      ...input,
      id: createMemoryId(),
      createdAt: Date.now(),
    };
    this.rawMessages.set(message.id, message);
    this.emit({ type: "raw_message_appended", message });
    return message;
  }

  async appendObservation(input: Omit<Observation, "id" | "createdAt">): Promise<Observation> {
    const observation: Observation = {
      ...input,
      id: createMemoryId(),
      createdAt: Date.now(),
    };
    this.observations.set(observation.id, observation);
    this.emit({ type: "observation_appended", observation });
    return observation;
  }

  async recall(query: ObservationQuery): Promise<Observation[]> {
    let candidates = Array.from(this.observations.values());

    if (query.sessionId) {
      candidates = candidates.filter(
        (observation) =>
          observation.sessionId === query.sessionId || observation.scope === "resource",
      );
    }
    if (query.scope) {
      candidates = candidates.filter((observation) => observation.scope === query.scope);
    }
    if (query.tags?.length) {
      candidates = candidates.filter((observation) =>
        query.tags!.some((tag) => observation.tags.includes(tag)),
      );
    }
    if (query.minPriority) {
      const minRank = priorityRank(query.minPriority);
      candidates = candidates.filter(
        (observation) => priorityRank(observation.priority) >= minRank,
      );
    }
    if (query.query) {
      const terms = tokenize(query.query);
      candidates = candidates.sort((a, b) => textScore(b, terms) - textScore(a, terms));
    } else {
      candidates.sort((a, b) => b.createdAt - a.createdAt);
    }
    return candidates.slice(0, query.limit ?? 10);
  }

  async getSnapshot(sessionId: SessionId): Promise<ObservationalMemorySnapshot> {
    const observations = Array.from(this.observations.values())
      .filter(
        (observation) => observation.sessionId === sessionId || observation.scope === "resource",
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const messages = Array.from(this.rawMessages.values())
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const updatedAt = Date.now();
    return {
      sessionId,
      observations,
      rawMessages: messages,
      estimatedTokens: {
        observations: estimateTokens(observations.map((item) => item.content).join("\n")),
        rawMessages: estimateTokens(messages.map((item) => item.content).join("\n")),
      },
      updatedAt,
    };
  }

  async replaceRawMessages(sessionId: SessionId, messages: RawMemoryMessage[]): Promise<void> {
    for (const [id, message] of this.rawMessages) {
      if (message.sessionId === sessionId) {
        this.rawMessages.delete(id);
      }
    }
    for (const message of messages) {
      this.rawMessages.set(message.id, message);
    }
    this.emit({ type: "raw_messages_replaced", sessionId, messages });
  }

  async replaceObservations(sessionId: SessionId, observations: Observation[]): Promise<void> {
    for (const [id, observation] of this.observations) {
      if (observation.sessionId === sessionId && observation.scope !== "resource") {
        this.observations.delete(id);
      }
    }
    for (const observation of observations) {
      this.observations.set(observation.id, observation);
    }
    this.emit({ type: "observations_replaced", sessionId, observations });
  }

  render(snapshot: ObservationalMemorySnapshot): string {
    const observationLines = snapshot.observations.map(formatObservation);
    const rawLines = snapshot.rawMessages.map((message) => `- ${message.role}: ${message.content}`);
    return [
      "## Observations",
      observationLines.length > 0 ? observationLines.join("\n") : "(none)",
      "",
      "## Raw Messages",
      rawLines.length > 0 ? rawLines.join("\n") : "(none)",
    ].join("\n");
  }

  private emit(event: MemoryStoreEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

function priorityRank(priority: ObservationPriority): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function priorityMarker(priority: ObservationPriority): string {
  return priority === "high" ? "HIGH" : priority === "medium" ? "MED" : "LOW";
}

function formatObservation(observation: Observation): string {
  const time = observation.timeOfDay ? ` ${observation.timeOfDay}` : "";
  const referenced = observation.referencedDate ? ` [ref: ${observation.referencedDate}]` : "";
  return `- ${priorityMarker(observation.priority)} ${observation.observedDate}${time}${referenced} ${observation.content}`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function textScore(observation: Observation, terms: Set<string>): number {
  const text = `${observation.content} ${observation.tags.join(" ")}`.toLowerCase();
  let score = priorityRank(observation.priority);
  for (const term of terms) {
    if (text.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
