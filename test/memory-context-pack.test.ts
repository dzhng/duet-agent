import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import { runMigrations } from "../src/memory/migrations.js";
import { resolveObservationalMemorySettings } from "../src/memory/observational.js";
import { MemoryStore } from "../src/memory/store.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Cache stability is the entire point of the frozen contextPack
 * design. These tests pin the invariant: appending observations or
 * recalling memory does NOT change what the transform renders. Only
 * an explicit compaction trigger (rebuildMemoryContextPack) does.
 */
describe("Memory context pack", () => {
  test("MemoryStore.getContextPack returns empty arrays before any refresh", () => {
    const store = new MemoryStore();
    const pack = store.getContextPack();
    expect(pack).toEqual({ global: [], local: [] });
  });

  test("appending observations does not mutate the frozen pack", async () => {
    const store = new MemoryStore();
    store.setContextPack({ global: [], local: [] });

    await store.appendObservation({
      kind: "observation",
      observedDate: "2026-05-09",
      priority: "high",
      source: { kind: "system" },
      content: "Mid-turn observation that must not leak into the prefix.",
      tags: [],
    });

    // Reading after the append: the pack is still the empty value we
    // froze. The append flowed to the in-memory map and to disk in
    // production, but the rendered prefix did not change.
    expect(store.getContextPack()).toEqual({ global: [], local: [] });
  });

  test("setContextPack is the only way to change what the transform renders", () => {
    const store = new MemoryStore();
    const next: { global: Observation[]; local: Observation[] } = {
      global: [
        {
          id: "g1",
          createdAt: 1,
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
    store.setContextPack(next);
    expect(store.getContextPack()).toBe(next);
  });

  testIfDocker("rebuildMemoryContextPack assembles global + local from the database", async () => {
    await withSeededDb(async (db) => {
      const store = new MemoryStore();
      const settings = resolveObservationalMemorySettings({});

      await rebuildMemoryContextPack({
        db,
        store,
        settings,
        sessionId: "session_current",
      });

      const pack = store.getContextPack();

      // Global pack carries cross-session rows ranked by score.
      expect(pack.global.map((row) => row.id)).toContain("mem_other_session");
      expect(pack.global.map((row) => row.id)).not.toContain("mem_current");

      // Local pack carries only the current session's rows in
      // chronological order.
      expect(pack.local.map((row) => row.id)).toEqual(["mem_current"]);
    });
  });

  testIfDocker("rebuildMemoryContextPack with no sessionId leaves local empty", async () => {
    await withSeededDb(async (db) => {
      const store = new MemoryStore();
      const settings = resolveObservationalMemorySettings({});

      await rebuildMemoryContextPack({ db, store, settings });

      const pack = store.getContextPack();
      expect(pack.local).toEqual([]);
      // Global still loads everything since exclusion is undefined.
      expect(pack.global.length).toBeGreaterThan(0);
    });
  });
});

async function withSeededDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-context-pack-"));
  const db = await PGlite.create({
    dataDir: join(tempDir, "memory.db"),
    extensions: { vector },
  });
  try {
    await runMigrations(db);
    await db.exec(`
      INSERT INTO observations (
        id, created_at, session_id, kind, observed_date, priority, source_json, content, tags_json
      ) VALUES
        ('mem_current', 1, 'session_current', 'observation', '2026-05-09', 'high',
         '{"kind":"system"}', 'Belongs to the current session.', '[]'),
        ('mem_other_session', 2, 'session_a', 'reflection', '2026-05-09', 'high',
         '{"kind":"system"}', 'Belongs to another session.', '[]');
    `);
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
