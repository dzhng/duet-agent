import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryId } from "../core/ids.js";
import type {
  MemoryId,
  MemoryStore,
  Observation,
  ObservationPriority,
  ObservationQuery,
  ObservationalMemorySnapshot,
  RawMemoryMessage,
  SessionId,
} from "../core/types.js";

/**
 * File-backed observational memory store.
 * This persists the two blocks observational memory needs:
 * durable observations and uncompressed raw messages.
 */
export class FileMemoryStore implements MemoryStore {
  private observations: Map<MemoryId, Observation> = new Map();
  private rawMessages: Map<MemoryId, RawMemoryMessage> = new Map();
  private loaded = false;

  constructor(private readonly dir: string) {}

  private get indexPath(): string {
    return join(this.dir, "observational-memory.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const entries = JSON.parse(raw) as {
        observations?: Observation[];
        rawMessages?: RawMemoryMessage[];
      };
      for (const observation of entries.observations ?? []) {
        this.observations.set(observation.id, observation);
      }
      for (const message of entries.rawMessages ?? []) {
        this.rawMessages.set(message.id, message);
      }
    } catch {
      // Fresh store — no file yet.
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.indexPath,
      JSON.stringify(
        {
          observations: Array.from(this.observations.values()),
          rawMessages: Array.from(this.rawMessages.values()),
        },
        null,
        2
      )
    );
  }

  async appendRawMessage(
    input: Omit<RawMemoryMessage, "id" | "createdAt">
  ): Promise<RawMemoryMessage> {
    await this.ensureLoaded();
    const message: RawMemoryMessage = {
      ...input,
      id: createMemoryId(),
      createdAt: Date.now(),
    };
    this.rawMessages.set(message.id, message);
    await this.persist();
    return message;
  }

  async appendObservation(
    input: Omit<Observation, "id" | "createdAt">
  ): Promise<Observation> {
    await this.ensureLoaded();
    const observation: Observation = {
      ...input,
      id: createMemoryId(),
      createdAt: Date.now(),
    };
    this.observations.set(observation.id, observation);
    await this.persist();
    return observation;
  }

  async recall(query: ObservationQuery): Promise<Observation[]> {
    await this.ensureLoaded();
    let candidates = Array.from(this.observations.values());

    if (query.sessionId) {
      candidates = candidates.filter(
        (observation) =>
          observation.sessionId === query.sessionId ||
          observation.scope === "resource"
      );
    }
    if (query.scope) {
      candidates = candidates.filter((observation) => observation.scope === query.scope);
    }
    if (query.tags?.length) {
      candidates = candidates.filter((observation) =>
        query.tags!.some((tag) => observation.tags.includes(tag))
      );
    }
    if (query.minPriority) {
      const minRank = priorityRank(query.minPriority);
      candidates = candidates.filter(
        (observation) => priorityRank(observation.priority) >= minRank
      );
    }
    if (query.query) {
      const terms = tokenize(query.query);
      candidates = candidates.sort(
        (a, b) => textScore(b, terms) - textScore(a, terms)
      );
    }
    if (!query.query) {
      candidates.sort((a, b) => b.createdAt - a.createdAt);
    }
    return candidates.slice(0, query.limit ?? 10);
  }

  async getSnapshot(sessionId: SessionId): Promise<ObservationalMemorySnapshot> {
    await this.ensureLoaded();
    const observations = Array.from(this.observations.values())
      .filter(
        (observation) =>
          observation.sessionId === sessionId ||
          observation.scope === "resource"
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const messages = Array.from(this.rawMessages.values())
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const updatedAt = Date.now();
    return {
      sessionId,
      observations: {
        sessionId,
        observations,
        updatedAt,
        estimatedTokens: estimateTokens(observations.map((item) => item.content).join("\n")),
      },
      raw: {
        sessionId,
        messages,
        updatedAt,
        estimatedTokens: estimateTokens(messages.map((item) => item.content).join("\n")),
      },
    };
  }

  async replaceRawMessages(
    sessionId: SessionId,
    messages: RawMemoryMessage[]
  ): Promise<void> {
    await this.ensureLoaded();
    for (const [id, message] of this.rawMessages) {
      if (message.sessionId === sessionId) {
        this.rawMessages.delete(id);
      }
    }
    for (const message of messages) {
      this.rawMessages.set(message.id, message);
    }
    await this.persist();
  }

  async replaceObservations(
    sessionId: SessionId,
    observations: Observation[]
  ): Promise<void> {
    await this.ensureLoaded();
    for (const [id, observation] of this.observations) {
      if (observation.sessionId === sessionId && observation.scope !== "resource") {
        this.observations.delete(id);
      }
    }
    for (const observation of observations) {
      this.observations.set(observation.id, observation);
    }
    await this.persist();
  }

  render(snapshot: ObservationalMemorySnapshot): string {
    const observationLines = snapshot.observations.observations.map(formatObservation);
    const rawLines = snapshot.raw.messages.map(
      (message) => `- ${message.role}: ${message.content}`
    );
    return [
      "## Observations",
      observationLines.length > 0 ? observationLines.join("\n") : "(none)",
      "",
      "## Raw Messages",
      rawLines.length > 0 ? rawLines.join("\n") : "(none)",
    ].join("\n");
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
  const referenced = observation.referencedDate
    ? ` [ref: ${observation.referencedDate}]`
    : "";
  return `- ${priorityMarker(observation.priority)} ${observation.observedDate}${time}${referenced} ${observation.content}`;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
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
