import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import { runMigrations } from "../src/memory/migrations.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
} from "../src/memory/observational.js";
import { MemorySession } from "../src/memory/session.js";
import { MemoryContextCache } from "../src/memory/store.js";
import { appendObservation } from "../src/memory/storage.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Cache stability is the entire point of the frozen contextPack
 * design. These tests pin the invariant: appending observations to
 * the durable store does NOT change what the transform renders. Only
 * an explicit compaction trigger (rebuildMemoryContextPack) does.
 */
describe("Memory context pack", () => {
  test("getContextPack returns empty arrays before any refresh", () => {
    const cache = new MemoryContextCache();
    expect(cache.getContextPack()).toEqual({ global: [], local: [] });
  });

  test("setContextPack is the only way to change what the transform renders", () => {
    const cache = new MemoryContextCache();
    const next: { global: Observation[]; local: Observation[] } = {
      global: [
        {
          id: "g1",
          createdAt: 1,
          lastUsedAt: 1,
          kind: "reflection",
          observedDate: "2026-05-09",
          priority: "high",
          source: { kind: "system" },
          content: "Long-term cross-session reflection.",
          tags: [],
        },
      ],
      local: [],
    };
    cache.setContextPack(next);
    expect(cache.getContextPack()).toBe(next);
  });

  testIfDocker(
    "appending observations to the database does not mutate the frozen pack",
    async () => {
      await withSeededDb(async (session) => {
        const cache = new MemoryContextCache();
        cache.setContextPack({ global: [], local: [] });

        await appendObservation(session, {
          sessionId: "session_current",
          kind: "observation",
          observedDate: "2026-05-09",
          priority: "high",
          source: { kind: "system" },
          content: "Mid-turn observation that must not leak into the prefix.",
          tags: [],
        });

        // The append flowed to disk but the rendered prefix did not
        // change — only a compaction trigger does that.
        expect(cache.getContextPack()).toEqual({ global: [], local: [] });
      });
    },
  );

  testIfDocker("rebuildMemoryContextPack assembles global + local from the database", async () => {
    await withSeededDb(async (session) => {
      const cache = new MemoryContextCache();
      const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

      await rebuildMemoryContextPack({
        session,
        cache,
        settings,
        sessionId: "session_current",
      });

      const pack = cache.getContextPack();

      // Global pack carries cross-session rows ranked by score.
      expect(pack.global.map((row) => row.id)).toContain("mem_other_session");
      expect(pack.global.map((row) => row.id)).not.toContain("mem_current");

      // Local pack carries only the current session's rows in
      // chronological order.
      expect(pack.local.map((row) => row.id)).toEqual(["mem_current"]);
    });
  });

  testIfDocker("rebuildMemoryContextPack with no sessionId leaves local empty", async () => {
    await withSeededDb(async (session) => {
      const cache = new MemoryContextCache();
      const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

      await rebuildMemoryContextPack({ session, cache, settings });

      const pack = cache.getContextPack();
      expect(pack.local).toEqual([]);
      // Global still loads everything since exclusion is undefined.
      expect(pack.global.length).toBeGreaterThan(0);
    });
  });
});

async function withSeededDb(fn: (session: MemorySession) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-context-pack-"));
  const session = new MemorySession({
    path: join(tempDir, "memory.db"),
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    // Tests run several ops back-to-back; keep the handle open across
    // them so the open cost is paid once per test rather than between
    // each helper call.
    idleCloseMs: 60_000,
  });
  try {
    await session.withDb(async (db) => {
      await db.exec(`
        INSERT INTO observations (
          id, created_at, last_used_at, session_id, kind, observed_date, priority, source_json, content, tags_json
        ) VALUES
          ('mem_current', 1, 1, 'session_current', 'observation', '2026-05-09', 'high',
           '{"kind":"system"}', 'Belongs to the current session.', '[]'),
          ('mem_other_session', 2, 2, 'session_a', 'reflection', '2026-05-09', 'high',
           '{"kind":"system"}', 'Belongs to another session.', '[]');
      `);
    });
    await fn(session);
  } finally {
    await session.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
}
