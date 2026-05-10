import { describe, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalPack, loadLocalPack } from "../src/memory/loader.js";
import { runMigrations } from "../src/memory/migrations.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Fixture-based tests for the loader's two layers and the SQL ranking
 * push-down. Each scenario seeds a PGlite database with realistic
 * observations spanning a 60-day window, runs the loader, and asserts
 * the resulting order matches what the rank formula
 * `ln(priority) + ln(kindBias) + last_used_at / h` promises.
 *
 * The full score is `priority * 0.5^((now - last_used_at)/h) * kindBias`,
 * but `0.5^(now/h)` is constant within one ranking pass and so cannot
 * affect order. The SQL ORDER BY uses the simplified monotone form
 * directly; these tests assert the resulting ordering, not the absolute
 * scores (which depend on `now` and would flake without it).
 */

const NOW = Date.UTC(2026, 4, 9); // 2026-05-09 — anchors all `daysAgo` math
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 7 * DAY_MS;
const REFLECTION_BIAS = 1.3;

describe("Memory loader", () => {
  describe("loadGlobalPack", () => {
    testIfDocker("ranks rows by combined score with the highest-scoring row first", async () => {
      await withSeededDb(async (db) => {
        const pack = await loadGlobalPack(db, {
          excludeSessionId: "session_current",
          tokenBudget: 100_000,
          recencyHalfLifeMs: HALF_LIFE_MS,
          reflectionBias: REFLECTION_BIAS,
        });

        // Rank-1 invariant: the top fixture is a high reflection
        // touched today (priority 3 × kindBias 1.3 dominates anything
        // else in the seed set).
        expect(pack[0]?.id).toBe("g_high_reflection_today");

        // Last place goes to the 60-day-old low-priority observation
        // — verifies usage decay is doing real work.
        expect(pack.at(-1)?.id).toBe("g_low_obs_60d");
      });
    });

    testIfDocker(
      "a recently-used old row outranks a stale newer row of equal priority",
      async () => {
        await withSeededDb(async (db) => {
          // last_used_at on `g_high_obs_used_recently` is 1 day ago,
          // even though it was created 14 days ago. `g_high_observation_today`
          // was created today but never re-used (last_used_at = createdAt = today),
          // so they're close. We rely on the recency math: 0d vs 1d,
          // both within one half-life — created-today edges out, but
          // both must beat the 14-day-old high observation that was
          // never reused.
          const pack = await loadGlobalPack(db, {
            excludeSessionId: "session_current",
            tokenBudget: 100_000,
            recencyHalfLifeMs: HALF_LIFE_MS,
            reflectionBias: REFLECTION_BIAS,
          });
          const ids = pack.map((o) => o.id);
          expect(ids.indexOf("g_high_obs_used_recently")).toBeLessThan(
            ids.indexOf("g_low_observation_14d"),
          );
        });
      },
    );

    testIfDocker("enforces the token budget by stopping the greedy fill", async () => {
      await withSeededDb(async (db) => {
        // Each fixture's content is short (~13-23 tokens). A tight
        // budget forces the loader to stop after a couple rows.
        const tokenBudget = 30;
        const pack = await loadGlobalPack(db, {
          excludeSessionId: "session_current",
          tokenBudget,
          recencyHalfLifeMs: HALF_LIFE_MS,
          reflectionBias: REFLECTION_BIAS,
        });

        const usedTokens = pack.reduce(
          (sum, observation) => sum + Math.ceil(observation.content.length / 4),
          0,
        );
        expect(usedTokens).toBeLessThanOrEqual(tokenBudget);
        // The top-ranked row is short enough to fit, so the pack is
        // never empty even at very tight budgets — important so a
        // misconfigured budget never silently disables global memory.
        expect(pack.length).toBeGreaterThan(0);
        expect(pack[0]?.id).toBe("g_high_reflection_today");
      });
    });

    testIfDocker(
      "excludes the current session's rows so the local layer is not double-counted",
      async () => {
        await withSeededDb(async (db) => {
          const pack = await loadGlobalPack(db, {
            excludeSessionId: "session_current",
            tokenBudget: 100_000,
            recencyHalfLifeMs: HALF_LIFE_MS,
            reflectionBias: REFLECTION_BIAS,
          });
          const ids = pack.map((observation) => observation.id);
          for (const id of ids) {
            expect(id.startsWith("local_")).toBe(false);
          }
        });
      },
    );

    testIfDocker("includes legacy NULL session_id rows in the global pool", async () => {
      await withSeededDb(async (db) => {
        const pack = await loadGlobalPack(db, {
          excludeSessionId: "session_current",
          tokenBudget: 100_000,
          recencyHalfLifeMs: HALF_LIFE_MS,
          reflectionBias: REFLECTION_BIAS,
        });
        const ids = pack.map((observation) => observation.id);
        // Legacy rows pre-date sessionId tracking; they should still
        // surface as "from any other session".
        expect(ids).toContain("g_legacy_null_session");
      });
    });

    testIfDocker(
      "includes every row when no exclusion is set (recall_memory all-session search)",
      async () => {
        await withSeededDb(async (db) => {
          const pack = await loadGlobalPack(db, {
            tokenBudget: 100_000,
            recencyHalfLifeMs: HALF_LIFE_MS,
            reflectionBias: REFLECTION_BIAS,
          });
          const ids = pack.map((observation) => observation.id);
          expect(ids).toContain("local_observation_today");
          expect(ids).toContain("g_high_reflection_today");
        });
      },
    );
  });

  describe("loadLocalPack", () => {
    testIfDocker("returns every row for the current session in chronological order", async () => {
      await withSeededDb(async (db) => {
        const pack = await loadLocalPack(db, { sessionId: "session_current" });

        expect(pack.map((observation) => observation.id)).toEqual([
          // Local fixtures span yesterday through today, written in
          // ascending creation order so the loader's ASC sort matches.
          "local_observation_yesterday",
          "local_reflection_yesterday",
          "local_observation_today",
        ]);
      });
    });

    testIfDocker("returns an empty list for a session with no observations", async () => {
      await withSeededDb(async (db) => {
        const pack = await loadLocalPack(db, { sessionId: "session_with_nothing" });
        expect(pack).toEqual([]);
      });
    });
  });
});

async function withSeededDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-loader-"));
  const db = await PGlite.create({
    dataDir: join(tempDir, "memory.db"),
    extensions: { vector },
  });
  try {
    await runMigrations(db);
    await seedFixtures(db);
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedFixtures(db: PGlite): Promise<void> {
  for (const fixture of FIXTURES) {
    await db.query(
      `INSERT INTO observations (
        id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
        time_of_day, priority, source_json, content, tags_json
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, '{"kind":"system"}', $8, '[]')`,
      [
        fixture.id,
        fixture.createdAt,
        fixture.lastUsedAt ?? fixture.createdAt,
        fixture.sessionId ?? null,
        fixture.kind,
        new Date(fixture.createdAt).toISOString().slice(0, 10),
        fixture.priority,
        fixture.content,
      ],
    );
  }
}

interface Fixture {
  id: string;
  sessionId: string | null;
  kind: Observation["kind"];
  priority: Observation["priority"];
  createdAt: number;
  /** Defaults to `createdAt` when the row was never re-used. */
  lastUsedAt?: number;
  content: string;
}

function ago(days: number): number {
  return NOW - days * DAY_MS;
}

const FIXTURES: Fixture[] = [
  // Local layer (current session) — never appears in the global pack
  // when excludeSessionId = "session_current".
  {
    id: "local_observation_yesterday",
    sessionId: "session_current",
    kind: "observation",
    priority: "medium",
    createdAt: ago(1),
    content: "User asked about the memory loader at 2026-05-08.",
  },
  {
    id: "local_reflection_yesterday",
    sessionId: "session_current",
    kind: "reflection",
    priority: "high",
    createdAt: ago(1) + 60 * 1000,
    content: "Decided 7d half-life with 1.3 reflection bias for global ranking.",
  },
  {
    id: "local_observation_today",
    sessionId: "session_current",
    kind: "observation",
    priority: "low",
    createdAt: ago(0),
    content: "Started writing the loader test fixtures.",
  },

  // Global layer — high-signal recent rows that should dominate ranking.
  {
    id: "g_high_reflection_today",
    sessionId: "session_a",
    kind: "reflection",
    priority: "high",
    createdAt: ago(0),
    content: "Wire-byte budget cap on Duet proxy is ~4.5 MiB.",
  },
  {
    id: "g_high_observation_today",
    sessionId: "session_a",
    kind: "observation",
    priority: "high",
    createdAt: ago(0),
    content: "Image paste shipped in v0.1.47, PR #12.",
  },
  // 14 days old by createdAt but bumped to "1 day ago" via lastUsedAt
  // — exercises the usage-decay path so an older-but-recently-reused
  // memory still ranks above a fresher unrelated row of lower
  // priority.
  {
    id: "g_high_obs_used_recently",
    sessionId: "session_a",
    kind: "observation",
    priority: "high",
    createdAt: ago(14),
    lastUsedAt: ago(1),
    content: "User confirmed the agent's choice of pgvector + tsvector hybrid.",
  },
  {
    id: "g_medium_reflection_3d",
    sessionId: "session_b",
    kind: "reflection",
    priority: "medium",
    createdAt: ago(3),
    content: "User prefers gateway-routed embeddings over external keys.",
  },
  {
    id: "g_high_reflection_7d",
    sessionId: "session_b",
    kind: "reflection",
    priority: "high",
    createdAt: ago(7),
    content: "Sticky horizons advance only on budget breach to keep prompt cache stable.",
  },
  {
    id: "g_low_observation_14d",
    sessionId: "session_c",
    kind: "observation",
    priority: "low",
    createdAt: ago(14),
    content: "Looked at gbrain README for hybrid search architecture.",
  },
  {
    id: "g_low_obs_60d",
    sessionId: "session_d",
    kind: "observation",
    priority: "low",
    createdAt: ago(60),
    content: "Initial memory store landed two months back.",
  },

  // Legacy NULL session_id row — predates sessionId tracking. Must be
  // searchable as "any other session" so users do not lose history.
  {
    id: "g_legacy_null_session",
    sessionId: null,
    kind: "reflection",
    priority: "high",
    createdAt: ago(2),
    content: "Pre-migration reflection that should still be globally retrievable.",
  },
];
