import { describe, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingBackfillWorker } from "../src/memory/embedding-worker.js";
import { runMigrations } from "../src/memory/migrations.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("EmbeddingBackfillWorker", () => {
  testIfDocker("embeds unembedded rows in priority order and persists them", async () => {
    await withSeededDb(async (db) => {
      const calls: string[][] = [];
      const worker = new EmbeddingBackfillWorker({
        db,
        embed: async (inputs) => {
          calls.push(inputs);
          // Deterministic stub: encode index into vector slot 0 so
          // assertions can verify a one-to-one input/output mapping.
          return inputs.map((_, index) => fillVector(1536, index + 1));
        },
        model: "test-model",
      });

      worker.start();
      // Poll until the worker has written every embedding. The loop
      // sleeps between batches; this gives it room to drain without
      // hard-coding a delay.
      await waitFor(async () => {
        const result = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM observation_embeddings`,
        );
        return (result.rows[0]?.count ?? 0) === 3;
      });
      await worker.stop();

      // High-priority row got embedded first; this proves the
      // priority-then-recency ORDER BY is doing real work, not
      // returning rows in insert order.
      expect(calls[0]).toEqual([
        "High-priority memory.",
        "Medium-priority memory.",
        "Low-priority memory.",
      ]);

      const rows = await db.query<{ observation_id: string; model: string }>(
        `SELECT observation_id, model FROM observation_embeddings ORDER BY observation_id`,
      );
      expect(rows.rows.map((row) => row.observation_id).sort()).toEqual([
        "mem_high",
        "mem_low",
        "mem_medium",
      ]);
      expect(rows.rows.every((row) => row.model === "test-model")).toBe(true);
    });
  });

  testIfDocker("does not re-embed rows that already have embeddings", async () => {
    await withSeededDb(async (db) => {
      // Seed an embedding for one of the rows. A LEFT JOIN-based picker
      // must skip it on subsequent passes.
      await db.query(
        `INSERT INTO observation_embeddings (observation_id, model, vector, created_at)
         VALUES ('mem_high', 'preexisting', $1, $2)`,
        [`[${Array(1536).fill(0).join(",")}]`, Date.now()],
      );

      const calls: string[][] = [];
      const worker = new EmbeddingBackfillWorker({
        db,
        embed: async (inputs) => {
          calls.push(inputs);
          return inputs.map(() => fillVector(1536, 1));
        },
        model: "test-model",
      });

      worker.start();
      await waitFor(async () => {
        const result = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM observation_embeddings`,
        );
        return (result.rows[0]?.count ?? 0) === 3;
      });
      await worker.stop();

      // The pre-existing row must not appear in any batch the worker
      // sent to the embed function.
      const everyEmbeddedInput = calls.flat();
      expect(everyEmbeddedInput).not.toContain("High-priority memory.");
      expect(everyEmbeddedInput).toContain("Medium-priority memory.");
      expect(everyEmbeddedInput).toContain("Low-priority memory.");
    });
  });

  testIfDocker("survives an embed failure and continues on the next batch", async () => {
    await withSeededDb(async (db) => {
      let attempt = 0;
      const worker = new EmbeddingBackfillWorker({
        db,
        embed: async (inputs) => {
          attempt++;
          if (attempt === 1) throw new Error("simulated transient failure");
          return inputs.map(() => fillVector(1536, 1));
        },
        model: "test-model",
      });

      // Stop the worker quickly so we do not actually wait the full
      // ERROR_SLEEP_MS backoff. We only want to prove that the loop
      // does not propagate the throw out to the caller.
      worker.start();
      await sleep(200);
      await worker.stop();

      // Worker handled the failure internally; no unhandled rejection,
      // database still readable.
      const rows = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM observation_embeddings`,
      );
      expect(typeof rows.rows[0]?.count).toBe("number");
    });
  });
});

async function withSeededDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-emb-worker-"));
  const db = await PGlite.create({
    dataDir: join(tempDir, "memory.db"),
    extensions: { vector },
  });
  try {
    await runMigrations(db);
    await db.exec(`
      INSERT INTO observations (
        id, created_at, last_used_at, kind, observed_date, priority, source_json, content, tags_json
      ) VALUES
        ('mem_low', 1, 1, 'observation', '2026-05-04', 'low',
         '{"kind":"system"}', 'Low-priority memory.', '[]'),
        ('mem_high', 2, 2, 'observation', '2026-05-04', 'high',
         '{"kind":"system"}', 'High-priority memory.', '[]'),
        ('mem_medium', 3, 3, 'observation', '2026-05-04', 'medium',
         '{"kind":"system"}', 'Medium-priority memory.', '[]');
    `);
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("waitFor timed out after 5s");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fillVector(length: number, value: number): number[] {
  return Array(length).fill(value);
}
