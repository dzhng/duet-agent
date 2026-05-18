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

/**
 * Unit-sized reflection evals.
 *
 * A single `reflectAllObservations` batch should emit MULTIPLE small,
 * atomic reflection rows — one per durable insight — instead of a
 * single mega-row that concatenates the whole batch. Each row must be
 * a bumpable unit so the recall freshness path can promote individual
 * insights without dragging unrelated noise along with them.
 */

const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

const PACK_ONE_BATCH = {
  minAgeMs: 0,
  batchTokens: Number.MAX_SAFE_INTEGER,
} as const;

const MAX_ROW_CHARS = 2400; // ~600 tokens at 4 chars/token.
const SPECIFIC_RE = /(2026-\d{2}-\d{2})|(#\d{2,5})|(src\/[\w./-]+)|\b[0-9a-f]{7,40}\b/;

function ngrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

describe("unit-sized reflections", () => {
  testIfDocker(
    "single batch produces multiple atomic reflection rows",
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
          expect(row.content).toMatch(SPECIFIC_RE);
        }
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
    "unit reflections do not repeat the same headline across rows",
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

        const rowGrams = rows.map((r) => ngrams(r.content, 6));
        let duplicateRows = 0;
        for (let i = 0; i < rowGrams.length; i++) {
          let sharesWithOther = false;
          for (let j = 0; j < rowGrams.length && !sharesWithOther; j++) {
            if (i === j) continue;
            for (const gram of rowGrams[i]!) {
              if (rowGrams[j]!.has(gram)) {
                sharesWithOther = true;
                break;
              }
            }
          }
          if (sharesWithOther) duplicateRows++;
        }
        const ratio = duplicateRows / rows.length;
        expect(ratio).toBeLessThan(0.2);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );
});
