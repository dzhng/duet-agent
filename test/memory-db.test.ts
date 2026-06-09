import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb, MEMORY_PAGE_SIZE, scoreObservation } from "../src/cli/memory-db.js";
import {
  DEFAULT_RECENCY_HALF_LIFE_MS,
  DEFAULT_REFLECTION_BIAS,
} from "../src/memory/observational.js";
import { PRIORITY_WEIGHT } from "../src/memory/loader.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Tests for the `duet memory` CLI database wrapper: the ranked, lazily-paged
 * query that backs the TUI list, the row count it pairs with, and the
 * per-row score the TUI displays. The ranked order must match the runner's
 * global-pack ranking (loader.ts) — highest `priority * 0.5^(age/halfLife) *
 * kindBias` first — across every session in one flat list.
 */

const NOW = Date.UTC(2026, 5, 5); // 2026-06-05
const DAY_MS = 24 * 60 * 60 * 1000;

describe("MemoryDb ranked paging", () => {
  testIfDocker("count returns the total across all sessions", async () => {
    await withDb(async (db) => {
      await seed(db, makeFixtures(60));
      expect(await db.count()).toBe(60);
    });
  });

  testIfDocker("listRanked returns one flat list ordered by score descending", async () => {
    await withDb(async (db) => {
      // A high-priority reflection used today must outrank a low-priority
      // observation that has not been touched in 60 days, regardless of
      // which session each came from or its created_at.
      await seed(db, [
        fixture({ id: "low_old", priority: "low", kind: "observation", lastUsedAt: ago(60) }),
        fixture({
          id: "high_reflection_today",
          priority: "high",
          kind: "reflection",
          lastUsedAt: NOW,
          sessionId: "s2",
        }),
        fixture({
          id: "medium_recent",
          priority: "medium",
          kind: "observation",
          lastUsedAt: ago(2),
        }),
      ]);

      const rows = await db.listRanked({ limit: 25, offset: 0, now: NOW });
      expect(rows.map((r) => r.id)).toEqual(["high_reflection_today", "medium_recent", "low_old"]);

      // The displayed score is the real numeric formula, not the SQL
      // log-space rank. Verify the top row matches the hand-computed value.
      const top = rows[0]!;
      const expected =
        PRIORITY_WEIGHT.high *
        DEFAULT_REFLECTION_BIAS *
        Math.pow(0.5, (NOW - top.lastUsedAt) / DEFAULT_RECENCY_HALF_LIFE_MS);
      expect(scoreObservation(top, NOW)).toBeCloseTo(expected, 6);
    });
  });

  testIfDocker("listRanked honors LIMIT/OFFSET for lazy pagination", async () => {
    await withDb(async (db) => {
      await seed(db, makeFixtures(60));

      const page1 = await db.listRanked({ limit: MEMORY_PAGE_SIZE, offset: 0, now: NOW });
      const page2 = await db.listRanked({
        limit: MEMORY_PAGE_SIZE,
        offset: MEMORY_PAGE_SIZE,
        now: NOW,
      });
      const page3 = await db.listRanked({
        limit: MEMORY_PAGE_SIZE,
        offset: MEMORY_PAGE_SIZE * 2,
        now: NOW,
      });

      expect(page1).toHaveLength(25);
      expect(page2).toHaveLength(25);
      expect(page3).toHaveLength(10); // 60 total - 50 = 10

      // Walking the pages in order reproduces a single full-table ranked
      // query: pages are disjoint, gapless, and globally ordered.
      const all = [...page1, ...page2, ...page3];
      expect(new Set(all.map((r) => r.id)).size).toBe(60);
      const full = await db.listRanked({ limit: 60, offset: 0, now: NOW });
      expect(all.map((r) => r.id)).toEqual(full.map((r) => r.id));

      // Order is the true score descending: the displayed score never
      // increases as we walk down the list.
      const scores = all.map((r) => scoreObservation(r, NOW));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]! + 1e-9);
      }
    });
  });

  testIfDocker("delete keeps the paged view consistent", async () => {
    await withDb(async (db) => {
      await seed(db, makeFixtures(30));
      const before = await db.listRanked({ limit: MEMORY_PAGE_SIZE, offset: 0, now: NOW });
      const victim = before[0]!.id;

      await db.delete(victim);

      expect(await db.count()).toBe(29);
      const after = await db.listRanked({ limit: MEMORY_PAGE_SIZE, offset: 0, now: NOW });
      expect(after.map((r) => r.id)).not.toContain(victim);
      expect(after).toHaveLength(25);
    });
  });
});

async function withDb(fn: (db: MemoryDb) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-db-"));
  const db = await MemoryDb.open(join(tempDir, "memory.db"));
  try {
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface FixtureInput {
  id: string;
  priority: Observation["priority"];
  kind: Observation["kind"];
  lastUsedAt: number;
  createdAt?: number;
  sessionId?: string | null;
}

function fixture(input: FixtureInput): Required<FixtureInput> {
  return {
    createdAt: input.lastUsedAt,
    sessionId: null,
    ...input,
  };
}

function ago(days: number): number {
  return NOW - days * DAY_MS;
}

const PRIORITIES: Observation["priority"][] = ["high", "medium", "low"];

function makeFixtures(n: number): Required<FixtureInput>[] {
  return Array.from({ length: n }, (_, i) =>
    fixture({
      id: `obs_${i}`,
      priority: PRIORITIES[i % 3]!,
      kind: i % 5 === 0 ? "reflection" : "observation",
      lastUsedAt: ago(i),
      sessionId: i % 2 === 0 ? "s_even" : "s_odd",
    }),
  );
}

async function seed(db: MemoryDb, fixtures: Required<FixtureInput>[]): Promise<void> {
  // MemoryDb does not expose an insert, so reach through to the underlying
  // PGlite handle the same shape the runner writes rows in.
  const pg = (db as unknown as { db: import("@electric-sql/pglite").PGlite }).db;
  for (const f of fixtures) {
    await pg.query(
      `INSERT INTO observations (
        id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
        time_of_day, priority, source_json, content, tags_json
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, '{"kind":"system"}', $8, '[]')`,
      [
        f.id,
        f.createdAt,
        f.lastUsedAt,
        f.sessionId,
        f.kind,
        new Date(f.createdAt).toISOString().slice(0, 10),
        f.priority,
        `content for ${f.id}`,
      ],
    );
  }
}
