import { nanoid } from "nanoid";
import type {
  MemoryStoreEvent,
  MemoryStoreEventHandler,
  Observation,
  ObservationPriority,
  ObservationQuery,
  ObservationalMemorySnapshot,
} from "../types/memory.js";

export class MemoryStore {
  private observations: Map<string, Observation> = new Map();
  private handlers = new Set<MemoryStoreEventHandler>();

  on(handler: MemoryStoreEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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

  async getSnapshot(): Promise<ObservationalMemorySnapshot> {
    const observations = Array.from(this.observations.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    const updatedAt = Date.now();
    return {
      observations,
      estimatedTokens: {
        observations: estimateTokens(observations.map((item) => item.content).join("\n")),
      },
      updatedAt,
    };
  }

  async replaceObservations(observations: Observation[]): Promise<void> {
    this.observations.clear();
    for (const observation of observations) {
      this.observations.set(observation.id, observation);
    }
    this.emit({ type: "observations_replaced", observations });
  }

  render(snapshot: ObservationalMemorySnapshot): string {
    const observationLines = snapshot.observations.map(formatObservation);
    return [
      "## Observations",
      observationLines.length > 0 ? observationLines.join("\n") : "(none)",
    ].join("\n");
  }

  private emit(event: MemoryStoreEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
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
