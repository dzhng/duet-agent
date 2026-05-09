import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/memory/migrations.js";
import { recallMemory, reciprocalRankFusion } from "../src/memory/recall.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("recall_memory", () => {
  describe("reciprocalRankFusion", () => {
    test("ranks rows that appear high in either list above singles", () => {
      const order = reciprocalRankFusion([
        // a is rank 0 in list 1 and 2 in list 2 — fused score is highest.
        [
          { id: "a", rank: 0 },
          { id: "b", rank: 1 },
        ],
        [
          { id: "c", rank: 0 },
          { id: "b", rank: 1 },
          { id: "a", rank: 2 },
        ],
      ]);
      expect(order[0]).toBe("a");
    });

    test("preserves first-seen order when scores tie", () => {
      const order = reciprocalRankFusion([
        [
          { id: "first", rank: 0 },
          { id: "second", rank: 1 },
        ],
        [
          { id: "third", rank: 0 },
          { id: "fourth", rank: 1 },
        ],
      ]);
      // First-seen tiebreak: list 1's rank-0 wins over list 2's rank-0.
      expect(order[0]).toBe("first");
      expect(order[1]).toBe("third");
    });
  });

  describe("recallMemory", () => {
    testIfDocker("returns keyword-only results when no embedding client is provided", async () => {
      await withSeededDb(async (db) => {
        const result = await recallMemory({
          db,
          query: "wire-byte",
          scope: "all",
        });

        expect(result.vectorSearchAttempted).toBe(false);
        expect(result.observations.map((row) => row.id)).toEqual(["mem_wire_budget"]);
      });
    });

    testIfDocker("falls back to keyword-only when the embed callable throws", async () => {
      await withSeededDb(async (db) => {
        const result = await recallMemory({
          db,
          embed: async () => {
            throw new Error("simulated outage");
          },
          query: "wire-byte",
          scope: "all",
        });

        // Vector path attempted but failed; keyword path still produced
        // a result. The tool layer surfaces the degraded mode in its
        // header so the model knows recall ran in fallback.
        expect(result.vectorSearchAttempted).toBe(true);
        expect(result.vectorSearchSucceeded).toBe(false);
        expect(result.observations.map((row) => row.id)).toEqual(["mem_wire_budget"]);
      });
    });

    testIfDocker("scope=session restricts to the given session", async () => {
      await withSeededDb(async (db) => {
        const result = await recallMemory({
          db,
          query: "memory",
          scope: "session",
          sessionId: "session_local",
        });
        for (const row of result.observations) {
          expect(row.sessionId).toBe("session_local");
        }
      });
    });

    testIfDocker(
      "scope=global excludes the current session and includes legacy NULL rows",
      async () => {
        await withSeededDb(async (db) => {
          const result = await recallMemory({
            db,
            query: "memory",
            scope: "global",
            sessionId: "session_local",
          });
          const ids = result.observations.map((row) => row.id);
          for (const id of ids) {
            expect(id.startsWith("mem_local")).toBe(false);
          }
          expect(ids).toContain("mem_legacy_null_session");
        });
      },
    );

    testIfDocker(
      "fuses keyword and vector results when an embedding client is provided",
      async () => {
        await withSeededDb(async (db) => {
          // Seed embeddings so the vector path returns rows. Each
          // embedding is a one-hot 1536-dim vector keyed off the
          // observation id so the test can predict cosine similarity:
          // mem_wire_budget gets a vector that exactly matches the
          // query embedding the stub returns.
          await seedEmbeddings(db);

          const result = await recallMemory({
            db,
            embed: async () => [oneHotVector(0)],
            query: "anything",
            scope: "all",
          });

          expect(result.vectorSearchAttempted).toBe(true);
          expect(result.vectorSearchSucceeded).toBe(true);
          // Ranked first because both keyword (matches "wire-byte" if
          // the query happened to match) and vector (exact match)
          // contribute. Even when only the vector path matches, the
          // tool returns it as the top hit.
          expect(result.observations[0]?.id).toBe("mem_wire_budget");
        });
      },
    );
  });
});

async function withSeededDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-recall-"));
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
        ('mem_local_today', 1, 'session_local', 'observation', '2026-05-09', 'medium',
         '{"kind":"system"}', 'Started writing recall memory tests today.', '[]'),
        ('mem_local_yesterday', 2, 'session_local', 'reflection', '2026-05-08', 'high',
         '{"kind":"system"}', 'Local session memory landed yesterday.', '[]'),
        ('mem_wire_budget', 3, 'session_a', 'reflection', '2026-05-07', 'high',
         '{"kind":"system"}', 'Wire-byte budget cap on the proxy is 4.5 MiB.', '[]'),
        ('mem_state_machine', 4, 'session_b', 'observation', '2026-05-06', 'medium',
         '{"kind":"system"}', 'State machine routing handles recurring tasks.', '[]'),
        ('mem_legacy_null_session', 5, NULL, 'reflection', '2026-04-15', 'high',
         '{"kind":"system"}', 'Legacy memory predating session id tracking.', '[]');
    `);
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedEmbeddings(db: PGlite): Promise<void> {
  // mem_wire_budget gets index 0 (a perfect match for our stub query
  // embedding); other rows get distinct indices so cosine ranks them
  // farther away.
  const rows = [
    ["mem_wire_budget", 0],
    ["mem_local_today", 1],
    ["mem_local_yesterday", 2],
    ["mem_state_machine", 3],
    ["mem_legacy_null_session", 4],
  ] as const;
  for (const [id, index] of rows) {
    await db.query(
      `INSERT INTO observation_embeddings (observation_id, model, vector, created_at)
       VALUES ($1, 'test-model', $2, $3)`,
      [id, formatVector(oneHotVector(index)), Date.now()],
    );
  }
}

function oneHotVector(activeIndex: number): number[] {
  const result = new Array<number>(1536).fill(0);
  result[activeIndex] = 1;
  return result;
}

function formatVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
