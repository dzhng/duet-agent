import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { runMigrations } from "../../src/memory/migrations.js";
import {
  appendObservation,
  readSessionObservations,
  type MemoryDatabase,
} from "../../src/memory/storage.js";
import { MemoryContextCache } from "../../src/memory/store.js";
import type { Observation } from "../../src/types/memory.js";

/**
 * Test-only memory fixture: a fresh PGlite database under a tmpdir,
 * a `MemoryContextCache`, and a few wrappers that mirror what tests
 * need against the durable store. Used by tests/evals that need a
 * real durable store without spinning up the full runner. Call
 * `dispose()` from a `finally` block to clean up the temp directory
 * and close the database.
 */
export interface MemoryFixture {
  db: MemoryDatabase;
  cache: MemoryContextCache;
  /** Convenience wrapper around `appendObservation` for direct test seeding. */
  append(input: Omit<Observation, "id" | "createdAt" | "lastUsedAt">): Promise<Observation>;
  /** Returns this session's observations and a rough token estimate. */
  snapshot(sessionId: string): ReturnType<typeof readSessionObservations>;
  dispose(): Promise<void>;
}

export async function createMemoryFixture(): Promise<MemoryFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-fixture-"));
  const db = await PGlite.create({
    dataDir: join(tempDir, "memory.db"),
    extensions: { vector },
  });
  await runMigrations(db);
  const cache = new MemoryContextCache();

  return {
    db,
    cache,
    append(input) {
      return appendObservation(db, input);
    },
    snapshot(sessionId) {
      return readSessionObservations(db, sessionId);
    },
    async dispose() {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
