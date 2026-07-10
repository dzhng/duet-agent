import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/memory/migrations.js";
import { recallMemory, reciprocalRankFusion } from "../src/memory/recall.js";
import { MemorySession } from "../src/memory/session.js";
import { appendObservation } from "../src/memory/storage.js";
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

    test("breaks an RRF tie toward the manual row via the kind prior", () => {
      // Both rows rank 0 in their own list, so the raw RRF scores tie. The
      // manual row's kind prior (1.5) lifts it above the plain observation.
      const order = reciprocalRankFusion([
        [{ id: "obs", rank: 0, kind: "observation", priority: "medium" }],
        [{ id: "man", rank: 0, kind: "manual", priority: "medium" }],
      ]);
      expect(order).toEqual(["man", "obs"]);
    });

    test("prior is a tiebreaker, not a dominator: strong relevance still wins", () => {
      // The observation appears at rank 0 in both lists (fused ~0.0333); the
      // manual+high row appears once at rank 5 (fused ~0.0154). Even with its
      // full prior (1.5 * 1.2 = 1.8 → ~0.0277) the strongly-matching
      // observation stays on top — the prior cannot override a clear
      // relevance gap.
      const order = reciprocalRankFusion([
        [
          { id: "obs", rank: 0, kind: "observation", priority: "medium" },
          { id: "man", rank: 5, kind: "manual", priority: "high" },
        ],
        [{ id: "obs", rank: 0, kind: "observation", priority: "medium" }],
      ]);
      expect(order[0]).toBe("obs");
    });

    test("orders kind priors note above reflection, below manual at equal rank", () => {
      const order = reciprocalRankFusion([
        [
          { id: "refl", rank: 0, kind: "reflection", priority: "medium" },
          { id: "note", rank: 0, kind: "note", priority: "medium" },
          { id: "man", rank: 0, kind: "manual", priority: "medium" },
        ],
      ]);
      // manual (1.5) > note (1.3) > reflection (1.25) at the same fused rank.
      expect(order).toEqual(["man", "note", "refl"]);
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
      await withSeededDb(async (session) => {
        const result = await recallMemory({
          session,
          query: "wire-byte",
          scope: "all",
        });

        expect(result.vectorSearchAttempted).toBe(false);
        expect(result.observations.map((row) => row.id)).toEqual(["mem_wire_budget"]);
      });
    });

    testIfDocker("falls back to keyword-only when the embed callable throws", async () => {
      await withSeededDb(async (session) => {
        const result = await recallMemory({
          session,
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
      await withSeededDb(async (session) => {
        const result = await recallMemory({
          session,
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
        await withSeededDb(async (session) => {
          const result = await recallMemory({
            session,
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

    testIfDocker("reports vector success on zero hits from a healthy (empty) index", async () => {
      await withSeededDb(async (session) => {
        // No embeddings are seeded, so the vector query runs against an
        // empty index and returns zero rows without throwing. That is a
        // successful search — only a thrown embed/query may flag
        // degraded mode, otherwise every zero-hit recall would print
        // the "semantic search unavailable" notice.
        const result = await recallMemory({
          session,
          embed: async () => ({ embeddings: [oneHotVector(0)], model: "test-model" }),
          query: "wire-byte",
          scope: "all",
        });

        expect(result.vectorSearchAttempted).toBe(true);
        expect(result.vectorSearchSucceeded).toBe(true);
        expect(result.observations.map((row) => row.id)).toEqual(["mem_wire_budget"]);
      });
    });

    testIfDocker(
      "finds a row embedded at insert via the vector path when keywords miss",
      async () => {
        await withSeededDb(async (session) => {
          // Same-vector stub for every input: the row embedded at insert
          // and the recall query land on identical vectors, so cosine
          // distance is zero and the vector path must return the row.
          const embed = async (inputs: string[]) => ({
            embeddings: inputs.map(() => oneHotVector(7)),
            model: "test-model",
          });
          const observation = await appendObservation(
            session,
            {
              kind: "note",
              priority: "medium",
              source: { kind: "user" },
              content: "Northstar Robotics keeps enterprise discounts at 20 percent",
              tags: [],
              observedDate: "2026-07-10",
            },
            { embed },
          );
          expect(observation).toBeDefined();

          // A verbose paraphrase: websearch_to_tsquery ANDs every term,
          // so "deal pricing negotiation" kills the keyword path. Only
          // the insert-time embedding can surface the row.
          const result = await recallMemory({
            session,
            embed,
            query: "Northstar Robotics discount deal pricing negotiation",
            scope: "all",
          });

          expect(result.vectorSearchAttempted).toBe(true);
          expect(result.vectorSearchSucceeded).toBe(true);
          expect(result.observations.map((row) => row.id)).toContain(observation!.id);
        });
      },
    );

    testIfDocker(
      "fuses keyword and vector results when an embedding client is provided",
      async () => {
        await withSeededDb(async (session) => {
          // Seed embeddings so the vector path returns rows. Each
          // embedding is a one-hot 3072-dim vector keyed off the
          // observation id so the test can predict cosine similarity:
          // mem_wire_budget gets a vector that exactly matches the
          // query embedding the stub returns.
          await session.withDb((db) => seedEmbeddings(db));

          const result = await recallMemory({
            session,
            embed: async () => ({ embeddings: [oneHotVector(0)], model: "test-model" }),
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

async function withSeededDb(fn: (session: MemorySession) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-recall-"));
  const session = new MemorySession({
    path: join(tempDir, "memory.db"),
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    // Hold the handle open across the test body so recall + embedding
    // seeding run on the same open. Production's 2s default would
    // churn the handle between every helper call.
    idleCloseMs: 60_000,
  });
  try {
    await session.withDb(async (db) => {
      await db.exec(`
        INSERT INTO observations (
          id, created_at, last_used_at, session_id, kind, observed_date, priority, source_json, content, tags_json
        ) VALUES
          ('mem_local_today', 1, 1, 'session_local', 'observation', '2026-05-09', 'medium',
           '{"kind":"system"}', 'Started writing recall memory tests today.', '[]'),
          ('mem_local_yesterday', 2, 2, 'session_local', 'reflection', '2026-05-08', 'high',
           '{"kind":"system"}', 'Local session memory landed yesterday.', '[]'),
          ('mem_wire_budget', 3, 3, 'session_a', 'reflection', '2026-05-07', 'high',
           '{"kind":"system"}', 'Wire-byte budget cap on the proxy is 4.5 MiB.', '[]'),
          ('mem_state_machine', 4, 4, 'session_b', 'observation', '2026-05-06', 'medium',
           '{"kind":"system"}', 'State machine routing handles recurring tasks.', '[]'),
          ('mem_legacy_null_session', 5, 5, NULL, 'reflection', '2026-04-15', 'high',
           '{"kind":"system"}', 'Legacy memory predating session id tracking.', '[]');
      `);
    });
    await fn(session);
  } finally {
    await session.dispose();
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
  const result = new Array<number>(3072).fill(0);
  result[activeIndex] = 1;
  return result;
}

function formatVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
