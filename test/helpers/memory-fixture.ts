import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/memory/migrations.js";
import { MemorySession } from "../../src/memory/session.js";
import {
  appendObservation,
  readSessionObservations,
  type SessionObservationsSnapshot,
} from "../../src/memory/storage.js";
import { MemoryContextCache } from "../../src/memory/store.js";
import type { Observation } from "../../src/types/memory.js";

/**
 * Test-only memory fixture: a fresh `MemorySession` rooted at a
 * tmpdir, a `MemoryContextCache`, and a few wrappers that mirror what
 * tests need against the durable store. Used by tests/evals that need
 * a real durable store without spinning up the full runner. Call
 * `dispose()` from a `finally` block to clean up the temp directory
 * and close the database.
 *
 * The fixture uses a long idle-close window so the session keeps the
 * PGlite handle open across the test body — tests run many ops in
 * quick succession and re-paying the open cost between each is both
 * slow and noisy. `dispose()` still cleans up the lock.
 */
export interface MemoryFixture {
  session: MemorySession;
  cache: MemoryContextCache;
  /** Convenience wrapper around `appendObservation` for direct test seeding. */
  append(input: Omit<Observation, "id" | "createdAt" | "lastUsedAt">): Promise<Observation>;
  /** Returns this session's observations and a rough token estimate. */
  snapshot(sessionId: string): Promise<SessionObservationsSnapshot>;
  dispose(): Promise<void>;
}

export async function createMemoryFixture(): Promise<MemoryFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-fixture-"));
  const session = new MemorySession({
    path: join(tempDir, "memory.db"),
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    // Keep the handle open for the entire test body; ops are short and
    // back-to-back, so the production 2s default would force a re-open
    // between every assertion.
    idleCloseMs: 60_000,
  });
  const cache = new MemoryContextCache();

  return {
    session,
    cache,
    async append(input) {
      const observation = await appendObservation(session, input);
      if (!observation) {
        throw new Error("memory fixture: appendObservation returned undefined");
      }
      return observation;
    },
    snapshot(sessionId) {
      return readSessionObservations(session, sessionId);
    },
    async dispose() {
      await session.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
