import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rebuildMemoryContextPack,
  rebuildPinnedStoreContextPack,
} from "../src/memory/context-pack.js";
import { runMigrations } from "../src/memory/migrations.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
} from "../src/memory/observational.js";
import { MemorySession } from "../src/memory/session.js";
import { MemoryContextCache } from "../src/memory/store.js";
import { appendObservation } from "../src/memory/storage.js";
import type { Observation } from "../src/types/memory.js";
import type { StoredMemory } from "../src/memory/store/store.js";
import { writeEntry } from "../src/memory/store/store.js";
import { estimateTokens } from "../src/memory/observational.js";
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
    expect(cache.getContextPack()).toEqual({ stored: [], global: [], local: [] });
  });

  test("database and stored layers refresh independently", () => {
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
    const stored = [storedMemory("pinned", "Pinned file memory.")];
    cache.setStoredContextPack(stored);
    cache.setContextPack(next);
    expect(cache.getContextPack()).toEqual({ stored, ...next });

    const replacement = [storedMemory("replacement", "Refreshed file memory.")];
    cache.setStoredContextPack(replacement);
    expect(cache.getContextPack()).toEqual({ stored: replacement, ...next });
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
        expect(cache.getContextPack()).toEqual({ stored: [], global: [], local: [] });
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

  testIfDocker("stored and global packs keep independent 15k and 8k budgets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-context-budget-"));
    const store = join(tempDir, ".agents", "memories");
    const session = new MemorySession({
      path: join(tempDir, "memory.db"),
      openOptions: { init: async (db) => void (await runMigrations(db)) },
      idleCloseMs: 60_000,
    });
    try {
      await writeEntry(store, {
        slug: "full-pinned-budget",
        version: 1,
        id: "mem_full_pinned_budget",
        kind: "train",
        createdAt: 2,
        content: "s".repeat(48_000),
      });
      await appendObservation(session, {
        sessionId: "other",
        kind: "observation",
        observedDate: "2026-07-23",
        priority: "high",
        source: { kind: "system" },
        content: "g".repeat(25_600),
        tags: [],
      });
      const cache = new MemoryContextCache();

      await rebuildPinnedStoreContextPack({ stores: [store], cache });
      await rebuildMemoryContextPack({
        session,
        cache,
        settings: resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT),
      });

      const pack = cache.getContextPack();
      expect(pack.stored.reduce((sum, row) => sum + estimateTokens(row.content), 0)).toBe(15_000);
      expect(pack.global.reduce((sum, row) => sum + estimateTokens(row.content), 0)).toBe(8_000);
    } finally {
      await session.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function storedMemory(slug: string, content: string): StoredMemory {
  return {
    slug,
    storeDir: "/tmp/.agents/memories",
    id: `mem_${slug}`,
    kind: "train",
    createdAt: 1,
    content,
  };
}

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
