import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS,
  DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS,
  PINNED_TAG,
  planReflectionBatches,
  reflectAllObservations,
  resolveObservationalMemorySettings,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import type { Observation } from "../src/types/memory.js";
import { createMemoryFixture } from "./helpers/memory-fixture.js";

/**
 * Pure-function tests for `planReflectionBatches`. No model calls, no
 * filesystem — just verifies the partitioning rules motivated by the
 * resume-info-loss tradeoff documented on `DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS`:
 *
 *   - Fresh non-reflection rows survive (their session might still be
 *     resumed).
 *   - GLOBAL reflection rows (`sessionId === "__global_reflection__"`)
 *     survive: re-reflecting condensed text would only collapse it into
 *     vaguer text.
 *   - LOCAL reflection rows (`kind === "reflection"` with a real session
 *     id) become eligible — `duet memory reflect` is how the single-blob
 *     in-session reflections get broken up into atomic global rows.
 *   - Older raw observations are batched chronologically up to a
 *     per-batch token cap, mixing sessions for cross-session dedup.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeObservation(overrides: Partial<Observation> & { id: string }): Observation {
  return {
    id: overrides.id,
    createdAt: overrides.createdAt ?? 0,
    lastUsedAt: overrides.lastUsedAt ?? overrides.createdAt ?? 0,
    sessionId: overrides.sessionId ?? "session_a",
    kind: overrides.kind ?? "observation",
    observedDate: overrides.observedDate ?? "2026-05-17",
    priority: overrides.priority ?? "low",
    source: overrides.source ?? { kind: "system" },
    content: overrides.content ?? "x",
    tags: overrides.tags ?? ["observational-memory"],
  };
}

describe("planReflectionBatches", () => {
  const NOW = 1_700_000_000_000;
  const cutoff = NOW - DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS;

  test("preserves rows newer than the cutoff and batches older ones", () => {
    const fresh = makeObservation({ id: "fresh", createdAt: NOW - 1 * DAY_MS });
    const old1 = makeObservation({ id: "old1", createdAt: NOW - 5 * DAY_MS });
    const old2 = makeObservation({ id: "old2", createdAt: NOW - 7 * DAY_MS });

    const { preserved, batches } = planReflectionBatches([fresh, old1, old2], {
      cutoff,
      batchTokens: 1_000_000,
    });

    expect(preserved.map((o) => o.id)).toEqual(["fresh"]);
    expect(batches).toHaveLength(1);
    // Eligible rows sorted chronologically — oldest first so the reflector
    // sees natural session ordering.
    expect(batches[0]!.observations.map((o) => o.id)).toEqual(["old2", "old1"]);
  });

  test("preserves global reflection rows but folds local reflection rows", () => {
    const globalReflection = makeObservation({
      id: "global-refl",
      kind: "reflection",
      sessionId: "__global_reflection__",
      createdAt: NOW - 30 * DAY_MS,
      tags: ["observational-memory", "reflection", "global-prune"],
    });
    const localReflection = makeObservation({
      id: "local-refl",
      kind: "reflection",
      sessionId: "session_a",
      createdAt: NOW - 30 * DAY_MS,
      tags: ["observational-memory", "reflection"],
    });
    const oldRaw = makeObservation({
      id: "raw-old",
      createdAt: NOW - 30 * DAY_MS,
    });

    const { preserved, batches } = planReflectionBatches(
      [globalReflection, localReflection, oldRaw],
      { cutoff, batchTokens: 1_000_000 },
    );

    // Only the global reflection survives untouched; the local one
    // gets folded alongside raw observations.
    expect(preserved.map((o) => o.id)).toEqual(["global-refl"]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.observations.map((o) => o.id).sort()).toEqual(["local-refl", "raw-old"]);
  });

  test("preserves pinned rows regardless of age", () => {
    // Curated durable rows (e.g. `duet train` syntheses) carry the
    // `pinned` tag; the prune must never fold them no matter how old.
    const pinned = makeObservation({
      id: "pinned-old",
      createdAt: NOW - 365 * DAY_MS,
      priority: "high",
      tags: ["train", "train:my-corpus", PINNED_TAG],
    });
    const oldRaw = makeObservation({ id: "raw-old", createdAt: NOW - 10 * DAY_MS });

    const { preserved, batches } = planReflectionBatches([pinned, oldRaw], {
      cutoff,
      batchTokens: 1_000_000,
    });

    expect(preserved.map((o) => o.id)).toEqual(["pinned-old"]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.observations.map((o) => o.id)).toEqual(["raw-old"]);
  });

  test("pinned wins even for local reflection rows that would otherwise be eligible", () => {
    const pinnedLocalReflection = makeObservation({
      id: "pinned-refl",
      kind: "reflection",
      sessionId: "session_a",
      createdAt: NOW - 30 * DAY_MS,
      tags: ["observational-memory", "reflection", PINNED_TAG],
    });

    const { preserved, batches } = planReflectionBatches([pinnedLocalReflection], {
      cutoff,
      batchTokens: 1_000_000,
    });

    expect(preserved.map((o) => o.id)).toEqual(["pinned-refl"]);
    expect(batches).toEqual([]);
  });

  test("packs eligible rows greedily up to batchTokens, then rolls over", () => {
    // Each content is 40 chars => 13 tokens via the CHARS_PER_TOKEN=3.2 heuristic.
    const content = "x".repeat(40);
    const observations = Array.from({ length: 6 }, (_, i) =>
      makeObservation({
        id: `o${i}`,
        createdAt: NOW - (10 + i) * DAY_MS,
        content,
      }),
    );

    const { batches } = planReflectionBatches(observations, {
      cutoff,
      batchTokens: 30, // fits 2 rows (13+13=26) but not 3 (39) per batch
    });

    // Eligible rows packed chronologically (oldest → newest). Originals
    // were created at ages 10..15 days, so reverse index order = oldest
    // first.
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.observations.map((o) => o.id))).toEqual([
      ["o5", "o4"],
      ["o3", "o2"],
      ["o1", "o0"],
    ]);
    for (const batch of batches) {
      expect(batch.estimatedTokens).toBeLessThanOrEqual(30);
    }
  });

  test("oversize row is allowed to occupy its own batch instead of being dropped", () => {
    const giant = makeObservation({
      id: "giant",
      createdAt: NOW - 10 * DAY_MS,
      content: "y".repeat(1000), // ~250 tokens
    });
    const small = makeObservation({
      id: "small",
      createdAt: NOW - 11 * DAY_MS,
      content: "z".repeat(20),
    });

    const { batches } = planReflectionBatches([giant, small], {
      cutoff,
      batchTokens: 50,
    });

    // small (~5 tokens) packs first batch; giant (~250 tokens) exceeds
    // the cap but is kept in its own batch rather than dropped.
    expect(batches).toHaveLength(2);
    const ids = batches.map((b) => b.observations.map((o) => o.id));
    expect(ids).toEqual([["small"], ["giant"]]);
  });

  test("mixes sessions in the same batch for cross-session dedup", () => {
    const a1 = makeObservation({
      id: "a1",
      sessionId: "session_a",
      createdAt: NOW - 10 * DAY_MS,
    });
    const b1 = makeObservation({
      id: "b1",
      sessionId: "session_b",
      createdAt: NOW - 9 * DAY_MS,
    });
    const c1 = makeObservation({
      id: "c1",
      sessionId: "session_c",
      createdAt: NOW - 8 * DAY_MS,
    });

    const { batches } = planReflectionBatches([a1, b1, c1], {
      cutoff,
      batchTokens: 1_000_000,
    });

    expect(batches).toHaveLength(1);
    expect(new Set(batches[0]!.observations.map((o) => o.sessionId))).toEqual(
      new Set(["session_a", "session_b", "session_c"]),
    );
  });

  test("empty input produces zero batches", () => {
    const { preserved, batches } = planReflectionBatches([], {
      cutoff,
      batchTokens: 1_000_000,
    });
    expect(preserved).toEqual([]);
    expect(batches).toEqual([]);
  });

  test("entirely-fresh input produces zero batches and preserves everything", () => {
    const fresh1 = makeObservation({ id: "f1", createdAt: NOW - 1 * DAY_MS });
    const fresh2 = makeObservation({ id: "f2", createdAt: NOW - 2 * DAY_MS });
    const { preserved, batches } = planReflectionBatches([fresh1, fresh2], {
      cutoff,
      batchTokens: 1_000_000,
    });
    expect(preserved.map((o) => o.id).sort()).toEqual(["f1", "f2"]);
    expect(batches).toEqual([]);
  });

  test("default min-age is 3 days", () => {
    expect(DEFAULT_GLOBAL_REFLECT_MIN_AGE_DAYS).toBe(3);
    expect(DEFAULT_GLOBAL_REFLECT_MIN_AGE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});

describe("reflectAllObservations — short-circuit paths", () => {
  const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

  test("returns undefined when the store is empty", async () => {
    const fixture = await createMemoryFixture();
    try {
      const result = await reflectAllObservations({
        session: fixture.session,
        snapshot: { observations: [], estimatedObservationTokens: 0 },
        settings,
        model: DEFAULT_CLI_MEMORY_MODEL,
      });
      expect(result).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  test("returns empty reflections without calling the model when nothing is eligible", async () => {
    const fixture = await createMemoryFixture();
    try {
      // Seed three rows, all fresh OR existing-reflection. The model
      // must never be called: nothing is eligible. (If it were called,
      // the LLM call would error since the test runs without network/
      // gateway credentials configured.)
      const fresh = await fixture.append({
        sessionId: "session_fresh",
        kind: "observation",
        observedDate: "2026-05-17",
        priority: "low",
        source: { kind: "system" },
        content: "fresh raw observation",
        tags: ["observational-memory"],
      });
      const reflection = await fixture.append({
        sessionId: "__global_reflection__",
        kind: "reflection",
        observedDate: "2026-05-10",
        priority: "high",
        source: { kind: "system" },
        content: "prior reflection row",
        tags: ["observational-memory", "reflection", "global-prune"],
      });
      // Back-date the reflection to make it "old" — proves we still
      // preserve reflections regardless of age.
      await fixture.session.withDb(async (db) => {
        await db.query("UPDATE observations SET created_at = $1 WHERE id = $2", [
          Date.now() - 30 * DAY_MS,
          reflection.id,
        ]);
      });

      const snapshot = {
        observations: [fresh, reflection],
        estimatedObservationTokens: 100,
      };
      const result = await reflectAllObservations({
        session: fixture.session,
        snapshot,
        settings,
        model: DEFAULT_CLI_MEMORY_MODEL,
      });
      expect(result).toBeDefined();
      expect(result!.reflections).toEqual([]);
      expect(result!.eligible).toEqual([]);
      expect(result!.written).toBe(false);
      expect(result!.preserved.map((o) => o.id).sort()).toEqual([fresh.id, reflection.id].sort());
    } finally {
      await fixture.dispose();
    }
  });
});
