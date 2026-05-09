import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalPack, loadLocalPack, score } from "../src/memory/loader.js";
import { runMigrations } from "../src/memory/migrations.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Fixture-based tests that cover the ranking math and the local/global
 * split. Each scenario seeds a PGlite database with realistic-looking
 * observations spanning a 60-day window, runs the loader, and asserts
 * the resulting order is what the ranking formula promises.
 *
 * If a test fails after a ranking change, read the printed pack to
 * understand the new ordering before chasing the failure.
 */

const NOW = Date.UTC(2026, 4, 9); // 2026-05-09 — anchors all `daysAgo` math
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 7 * DAY_MS;
const REFLECTION_BIAS = 1.3;

describe("Memory loader", () => {
  describe("score function", () => {
    test("rewards priority over equal-aged observations", () => {
      const high = score(makeFixture({ priority: "high", daysAgo: 0 }), defaultInputs());
      const medium = score(makeFixture({ priority: "medium", daysAgo: 0 }), defaultInputs());
      const low = score(makeFixture({ priority: "low", daysAgo: 0 }), defaultInputs());
      expect(high).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(low);
    });

    test("decays scores by half each half-life", () => {
      const fresh = score(makeFixture({ priority: "high", daysAgo: 0 }), defaultInputs());
      const oneHalfLife = score(makeFixture({ priority: "high", daysAgo: 7 }), defaultInputs());
      const twoHalfLives = score(makeFixture({ priority: "high", daysAgo: 14 }), defaultInputs());
      expect(oneHalfLife).toBeCloseTo(fresh * 0.5, 5);
      expect(twoHalfLives).toBeCloseTo(fresh * 0.25, 5);
    });

    test("biases reflections above raw observations at the same priority and recency", () => {
      const reflection = score(
        makeFixture({ priority: "high", daysAgo: 0, kind: "reflection" }),
        defaultInputs(),
      );
      const observation = score(
        makeFixture({ priority: "high", daysAgo: 0, kind: "observation" }),
        defaultInputs(),
      );
      expect(reflection).toBe(observation * REFLECTION_BIAS);
    });

    test("lets fresh medium reflections beat stale high observations (crossover at one half-life)", () => {
      // medium reflection at 0d:  2 * 1.0 * 1.3 = 2.6
      // high observation at 7d:   3 * 0.5 * 1.0 = 1.5
      // Reflection wins, matching the design intent of biasing toward
      // condensed signal even when raw memories are higher priority.
      const mediumFresh = score(
        makeFixture({ priority: "medium", daysAgo: 0, kind: "reflection" }),
        defaultInputs(),
      );
      const highStale = score(
        makeFixture({ priority: "high", daysAgo: 7, kind: "observation" }),
        defaultInputs(),
      );
      expect(mediumFresh).toBeGreaterThan(highStale);
    });
  });

  describe("loadGlobalPack", () => {
    testIfDocker("ranks rows by combined score with the highest-scoring row first", async () => {
      await withSeededDb(async (db) => {
        const pack = await loadGlobalPack(db, {
          excludeSessionId: "session_current",
          tokenBudget: 100_000,
          recencyHalfLifeMs: HALF_LIFE_MS,
          reflectionBias: REFLECTION_BIAS,
          now: NOW,
        });

        // Rank-1 invariant: the highest-scoring fixture is a high
        // reflection from today (3 * 1.0 * 1.3 = 3.9). Nothing else in
        // the seed set scores higher.
        expect(pack[0]?.id).toBe("g_high_reflection_today");

        // Last place goes to the 60-day-old low-priority observation:
        // 1 * 0.5^(60/7) * 1.0 = ~0.0028. Verifies decay is doing real work.
        expect(pack.at(-1)?.id).toBe("g_low_obs_60d");
      });
    });

    testIfDocker("enforces the token budget by stopping the greedy fill", async () => {
      await withSeededDb(async (db) => {
        // Each fixture's content is short (~13-23 tokens). Setting a
        // tight budget forces the loader to stop after the first
        // couple of rows and validates the cap holds.
        const tokenBudget = 30;
        const pack = await loadGlobalPack(db, {
          excludeSessionId: "session_current",
          tokenBudget,
          recencyHalfLifeMs: HALF_LIFE_MS,
          reflectionBias: REFLECTION_BIAS,
          now: NOW,
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
            now: NOW,
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
          now: NOW,
        });
        const ids = pack.map((observation) => observation.id);
        // Legacy rows pre-date sessionId tracking; they should still be
        // searchable as "from any other session".
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
            now: NOW,
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

        // Local layer is unranked: a low-priority observation written
        // most recently still appears last, because chronology is what
        // makes the local summary readable as a thread.
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

/**
 * Seeds a PGlite database with a deterministic fixture set spanning
 * 0-60 days back, mixed priorities, both kinds, two sessions plus
 * legacy NULL-session rows. Inserted directly via SQL so the test does
 * not depend on the runner machinery.
 */
async function withSeededDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-loader-"));
  // Match the runtime's pgvector loading path so migration v3 can
  // CREATE EXTENSION vector inside this test database too.
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
        id, created_at, session_id, kind, observed_date, referenced_date, relative_date,
        time_of_day, priority, source_json, content, tags_json
      ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6, '{"kind":"system"}', $7, '[]')`,
      [
        fixture.id,
        fixture.createdAt,
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
  content: string;
}

function ago(days: number): number {
  return NOW - days * DAY_MS;
}

const FIXTURES: Fixture[] = [
  // Local layer (current session) — these never appear in the global pack
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

function makeFixture(opts: {
  priority: Observation["priority"];
  daysAgo: number;
  kind?: Observation["kind"];
}): Observation {
  return {
    id: "fixture",
    createdAt: ago(opts.daysAgo),
    kind: opts.kind ?? "observation",
    observedDate: "2026-05-09",
    priority: opts.priority,
    source: { kind: "system" },
    content: "x",
    tags: [],
  };
}

function defaultInputs() {
  return {
    now: NOW,
    halfLifeMs: HALF_LIFE_MS,
    reflectionBias: REFLECTION_BIAS,
  };
}
