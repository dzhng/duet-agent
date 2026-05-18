import { describe, expect } from "bun:test";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  GLOBAL_REFLECTION_SESSION_ID,
  reflectAllObservations,
  resolveObservationalMemorySettings,
} from "../src/memory/observational.js";
import { readAllObservations } from "../src/memory/storage.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { RECENT_POOL } from "./fixtures/global-reflect/recent-pool.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";
import {
  judgeConcreteIdentifiers,
  judgeDistinctInsights,
  judgeNarrativeShape,
} from "./helpers/reflection-judge.js";

/**
 * Unit-sized reflection evals.
 *
 * A single `reflectAllObservations` batch should emit MULTIPLE atomic
 * reflection rows — one durable insight per row — instead of a single
 * mega-row that concatenates the whole batch. Each row must be:
 *   - a bumpable unit so the recall freshness path can promote
 *     individual insights without dragging unrelated noise along, AND
 *   - a self-contained mini-narrative (trigger → journey → decision →
 *     rationale/lesson) so it stays useful weeks later when the
 *     original transcript is gone.
 *
 * Structural properties (row count, length cap, durable-pool
 * persistence) are checked with cheap assertions. Semantic properties
 * (narrative shape, concrete identifiers, no duplicate insights) are
 * checked with the dedicated reflection judges from
 * `evals/helpers/reflection-judge.ts`, which are themselves exercised
 * against known-answer fixtures in `evals/reflection-judge.eval.ts`.
 * If a judge starts misbehaving, the judge-eval catches it before
 * this eval pulls it into a real grading pass.
 */

const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

const PACK_ONE_BATCH = {
  minAgeMs: 0,
  batchTokens: Number.MAX_SAFE_INTEGER,
} as const;

// Generous upper bound — narrative rows are larger than bullet rows.
// ~1000 tokens at 4 chars/token. The narrative judge enforces
// "narrative, not kitchen sink"; this cap just catches runaway rows
// that swallow the whole pool.
const MAX_ROW_CHARS = 4000;

describe("unit-sized reflections", () => {
  testIfDocker(
    "single batch produces multiple atomic reflection rows under the per-row cap",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, RECENT_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          ...PACK_ONE_BATCH,
        });
        expect(result).toBeDefined();
        const rows = result!.reflections;
        expect(rows.length).toBeGreaterThanOrEqual(5);
        for (const row of rows) {
          expect(row.content.length).toBeLessThanOrEqual(MAX_ROW_CHARS);
        }
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );

  testIfDocker(
    "every row reads as a self-contained mini-narrative (judged)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, RECENT_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          ...PACK_ONE_BATCH,
        });
        expect(result).toBeDefined();
        const rows = result!.reflections;
        expect(rows.length).toBeGreaterThanOrEqual(5);

        const verdict = await judgeNarrativeShape(rows.map((r) => r.content));
        expect(verdict.valid, verdict.reason).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );

  testIfDocker(
    "every row anchors to concrete identifiers (judged)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, RECENT_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          ...PACK_ONE_BATCH,
        });
        expect(result).toBeDefined();
        const rows = result!.reflections;

        const verdict = await judgeConcreteIdentifiers(rows.map((r) => r.content));
        expect(verdict.valid, verdict.reason).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );

  testIfDocker(
    "reflection rows survive verbatim into the durable pool with kind=reflection",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, RECENT_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          ...PACK_ONE_BATCH,
        });
        expect(result).toBeDefined();
        const after = await readAllObservations(fixture.session);
        const reflected = after.observations.filter(
          (o) => o.sessionId === GLOBAL_REFLECTION_SESSION_ID,
        );
        expect(reflected.length).toBe(result!.reflections.length);
        for (const row of reflected) {
          expect(row.kind).toBe("reflection");
          expect(row.sessionId).toBe(GLOBAL_REFLECTION_SESSION_ID);
        }
        const byId = new Map(reflected.map((r) => [r.id, r.content]));
        for (const row of result!.reflections) {
          expect(byId.get(row.id)).toBe(row.content);
        }
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );

  testIfDocker(
    "no two rows cover the same distinct insight (judged)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, RECENT_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          ...PACK_ONE_BATCH,
        });
        expect(result).toBeDefined();
        const rows = result!.reflections;
        expect(rows.length).toBeGreaterThanOrEqual(5);

        const verdict = await judgeDistinctInsights(rows.map((r) => r.content));
        expect(verdict.valid, verdict.reason).toBe(true);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );
});
