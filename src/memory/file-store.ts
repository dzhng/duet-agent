import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryId } from "../core/ids.js";
import type { Memory, MemoryId, MemoryQuery, MemoryStore } from "../core/types.js";
import { cosineSimilarity, embedText } from "./embeddings.js";

/**
 * File-based memory store. Memories are persisted as JSON files on disk.
 * This is the default — no database required. Just files.
 *
 * Directory structure:
 *   <root>/
 *     memories.json   — the full memory index
 *     embeddings.bin  — (future) binary embedding cache
 */
export class FileMemoryStore implements MemoryStore {
  private memories: Map<MemoryId, Memory> = new Map();
  private loaded = false;

  constructor(private readonly dir: string) {}

  private get indexPath(): string {
    return join(this.dir, "memories.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const entries: Memory[] = JSON.parse(raw);
      for (const m of entries) {
        this.memories.set(m.id, m);
      }
    } catch {
      // Fresh store — no file yet.
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const entries = Array.from(this.memories.values());
    await writeFile(this.indexPath, JSON.stringify(entries, null, 2));
  }

  async write(
    input: Omit<Memory, "id" | "embedding" | "lastAccessedAt">
  ): Promise<Memory> {
    await this.ensureLoaded();
    const embedding = await embedText(input.content);
    const memory: Memory = {
      ...input,
      id: createMemoryId(),
      embedding,
      lastAccessedAt: Date.now(),
    };
    this.memories.set(memory.id, memory);
    await this.persist();
    return memory;
  }

  async recall(query: MemoryQuery): Promise<Memory[]> {
    await this.ensureLoaded();
    let candidates = Array.from(this.memories.values());

    // Filter by scope
    if (query.scope) {
      candidates = candidates.filter((m) => m.scope === query.scope);
    }

    // Filter by tags
    if (query.tags?.length) {
      candidates = candidates.filter((m) =>
        query.tags!.some((t) => m.tags.includes(t))
      );
    }

    // Filter by importance
    if (query.minImportance !== undefined) {
      candidates = candidates.filter(
        (m) => m.importance >= query.minImportance!
      );
    }

    // Semantic ranking
    if (query.query) {
      const queryEmbedding = await embedText(query.query);
      candidates = candidates
        .map((m) => ({
          memory: m,
          score: m.embedding
            ? cosineSimilarity(queryEmbedding, m.embedding)
            : 0,
        }))
        .sort((a, b) => b.score - a.score)
        .map((r) => r.memory);
    } else {
      // Sort by recency if no semantic query
      candidates.sort((a, b) => b.createdAt - a.createdAt);
    }

    const limit = query.limit ?? 10;
    const results = candidates.slice(0, limit);

    // Update access times
    const now = Date.now();
    for (const m of results) {
      m.lastAccessedAt = now;
    }
    await this.persist();

    return results;
  }

  async forget(id: MemoryId): Promise<void> {
    await this.ensureLoaded();
    this.memories.delete(id);
    await this.persist();
  }

  async consolidate(): Promise<void> {
    await this.ensureLoaded();

    // Decay: remove session memories older than 24h that haven't been accessed
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, m] of this.memories) {
      if (
        m.scope === "session" &&
        m.lastAccessedAt < dayAgo &&
        m.importance < 0.5
      ) {
        this.memories.delete(id);
      }
    }

    await this.persist();
  }
}
