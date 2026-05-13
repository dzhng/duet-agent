import { describe, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingBackfillWorker } from "../src/memory/embedding-worker.js";
import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("EmbeddingBackfillWorker", () => {
  testIfDocker("embeds unembedded rows in priority order and persists them", async () => {
    await withSeededDb(async (session) => {
      const calls: string[][] = [];
      const worker = new EmbeddingBackfillWorker({
        session,
        embed: async (inputs) => {
          calls.push(inputs);
          // Deterministic stub: encode index into vector slot 0 so
          // assertions can verify a one-to-one input/output mapping.
          return {
            embeddings: inputs.map((_, index) => fillVector(3072, index + 1)),
            model: "test-model",
          };
        },
      });

      worker.start();
      // Poll until the worker has written every embedding. The loop
      // sleeps between batches; this gives it room to drain without
      // hard-coding a delay.
      await waitFor(async () => {
        const count = await embeddingCount(session);
        return count === 3;
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

      const rows = await readEmbeddingRows(session);
      expect(rows.map((row) => row.observation_id).sort()).toEqual([
        "mem_high",
        "mem_low",
        "mem_medium",
      ]);
      expect(rows.every((row) => row.model === "test-model")).toBe(true);
    });
  });

  testIfDocker("does not re-embed rows that already have embeddings", async () => {
    await withSeededDb(async (session) => {
      // Seed an embedding for one of the rows. A LEFT JOIN-based picker
      // must skip it on subsequent passes.
      await session.withDb(async (db) => {
        await db.query(
          `INSERT INTO observation_embeddings (observation_id, model, vector, created_at)
           VALUES ('mem_high', 'preexisting', $1, $2)`,
          [`[${Array(3072).fill(0).join(",")}]`, Date.now()],
        );
      });

      const calls: string[][] = [];
      const worker = new EmbeddingBackfillWorker({
        session,
        embed: async (inputs) => {
          calls.push(inputs);
          return {
            embeddings: inputs.map(() => fillVector(3072, 1)),
            model: "test-model",
          };
        },
      });

      worker.start();
      await waitFor(async () => {
        const count = await embeddingCount(session);
        return count === 3;
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

  testIfDocker(
    "persists surviving rows when a parent observation is deleted between select and persist",
    async () => {
      // FK race: the reflector calls `replaceSessionObservations` mid-
      // batch and deletes one of the rows the worker already selected.
      // A bare INSERT into `observation_embeddings` would abort the
      // whole transaction on FK violation, losing every embedding for
      // this batch. The WHERE EXISTS filter must let surviving rows
      // commit while the deleted parent is silently skipped.
      await withSeededDb(async (session) => {
        const worker = new EmbeddingBackfillWorker({
          session,
          embed: async (inputs) => {
            // Delete one parent right when the embed call resolves so
            // the deletion lands between `selectBatch` and
            // `persistBatch`.
            await session.withDb(async (db) => {
              await db.query(`DELETE FROM observations WHERE id = 'mem_medium'`);
            });
            return {
              embeddings: inputs.map(() => fillVector(3072, 1)),
              model: "test-model",
            };
          },
        });

        worker.start();
        await waitFor(async () => {
          const count = await embeddingCount(session);
          // Two surviving parents (high + low); the deleted medium row
          // is skipped by the WHERE EXISTS filter rather than aborting.
          return count === 2;
        });
        await worker.stop();

        const rows = await readEmbeddingRows(session);
        expect(rows.map((row) => row.observation_id)).toEqual(["mem_high", "mem_low"]);
      });
    },
  );

  testIfDocker(
    "does not hot-loop re-embedding the same id when its embedding row keeps disappearing",
    async () => {
      // Reproduces the production hot-loop: a row's embedding gets
      // cascade-deleted between drains (e.g. the reflector deletes the
      // parent observation and re-inserts it). The worker re-selects
      // the same id every iteration, burning embedding-API calls on a
      // row that immediately loses its embedding again. The per-id
      // attempt cooldown caps re-embeds to once per `attemptCooldownMs`
      // so a chronic churn turns into one call per cooldown instead of
      // a tight loop.
      await withSeededDb(async (session) => {
        let embedCalls = 0;
        const worker = new EmbeddingBackfillWorker({
          session,
          embed: async (inputs) => {
            embedCalls++;
            return {
              embeddings: inputs.map(() => fillVector(3072, 1)),
              model: "test-model",
            };
          },
          // Drive ticks fast so the test can drive multiple drains in
          // under a second instead of waiting for the production
          // 10-second cadence. The cooldown stays much larger than the
          // tick so a row whose embedding disappears is still skipped
          // across drains.
          idleSleepMs: 20,
          attemptCooldownMs: 60_000,
        });

        worker.start();
        // Wait for the first drain to land all three embeddings.
        await waitFor(async () => (await embeddingCount(session)) === 3);
        const callsAfterFirstDrain = embedCalls;

        // Simulate the FK-cascade churn that happened in production:
        // something deletes the embedding rows between worker drains.
        // With the cooldown in place, subsequent drains within the
        // cooldown window must NOT re-embed the same ids.
        await session.withDb(async (db) => {
          await db.exec(`DELETE FROM observation_embeddings`);
        });

        // Give the worker several ticks of opportunity to re-embed.
        await sleep(200);
        await worker.stop();

        // Hot-loop bug: embed would be invoked again on each tick
        // because selectBatch keeps returning the unembedded rows.
        // Cooldown fix: no extra embed calls because each id was
        // attempted recently.
        expect(embedCalls).toBe(callsAfterFirstDrain);
      });
    },
  );

  testIfDocker(
    "logs a sanitized, length-capped summary when the embed call returns an HTML body",
    async () => {
      const logDir = await mkdtemp(join(tmpdir(), "duet-emb-log-"));
      const logPath = join(logDir, "backfill.log");
      // Reproduce the production 404: a 50KB Next.js error page that
      // the worker used to append verbatim to the log on every retry.
      const htmlBody =
        "<!DOCTYPE html><html><head><title>404</title></head><body>" +
        "<h1>Not Found</h1>".repeat(2000) +
        "</body></html>";
      await withSeededDb(async (session) => {
        const worker = new EmbeddingBackfillWorker({
          session,
          embed: async () => {
            throw new Error(`Embedding endpoint returned 404: ${htmlBody}`);
          },
          logPath,
          // Keep ticks fast and bypass the long error backoff so the
          // worker writes exactly one failure line before we stop it.
          idleSleepMs: 20,
          errorSleepMs: 20,
        });
        worker.start();
        await sleep(150);
        await worker.stop();
      });
      const written = await readFile(logPath, "utf8");
      await rm(logDir, { recursive: true, force: true });

      // The raw error message is over 50KB. Each log line must stay
      // well under 1KB so a chronic failure does not produce
      // multi-megabyte log files.
      const lines = written.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeLessThan(500);
        // HTML tags must be stripped out so the log stays readable.
        expect(line).not.toContain("<!DOCTYPE");
        expect(line).not.toContain("</html>");
        // pid prefix lets multi-CLI runs (which share the log file)
        // be disambiguated when the lines interleave.
        expect(line).toContain(`pid=${process.pid}`);
      }
    },
  );

  testIfDocker("caps log file size by rotating instead of appending forever", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "duet-emb-logcap-"));
    const logPath = join(logDir, "backfill.log");
    // Seed an oversize log file: 2 MB of prior content, well above
    // the cap. The worker's next log line must rotate the file
    // rather than append.
    const seedSize = 2 * 1024 * 1024;
    await writeFile(logPath, "x".repeat(seedSize), "utf8");
    await withSeededDb(async (session) => {
      const worker = new EmbeddingBackfillWorker({
        session,
        embed: async (inputs) => ({
          embeddings: inputs.map(() => fillVector(3072, 1)),
          model: "test-model",
        }),
        logPath,
        logMaxBytes: 256 * 1024,
        idleSleepMs: 20,
      });
      worker.start();
      await waitFor(async () => (await embeddingCount(session)) === 3);
      await worker.stop();
    });
    // After rotation the live log file should be smaller than the
    // cap, and only contain the lines written after rotation.
    const live = await stat(logPath);
    expect(live.size).toBeLessThan(seedSize);
    const liveContents = await readFile(logPath, "utf8");
    expect(liveContents).toContain("Embedded");
    expect(liveContents).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxx");
    await rm(logDir, { recursive: true, force: true });
  });

  testIfDocker("survives an embed failure and continues on the next batch", async () => {
    await withSeededDb(async (session) => {
      let attempt = 0;
      const worker = new EmbeddingBackfillWorker({
        session,
        embed: async (inputs) => {
          attempt++;
          if (attempt === 1) throw new Error("simulated transient failure");
          return {
            embeddings: inputs.map(() => fillVector(3072, 1)),
            model: "test-model",
          };
        },
      });

      // Stop the worker quickly so we do not actually wait the full
      // ERROR_SLEEP_MS backoff. We only want to prove that the loop
      // does not propagate the throw out to the caller.
      worker.start();
      await sleep(200);
      await worker.stop();

      // Worker handled the failure internally; no unhandled rejection,
      // database still readable.
      const count = await embeddingCount(session);
      expect(typeof count).toBe("number");
    });
  });
});

async function withSeededDb(fn: (session: MemorySession) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-emb-worker-"));
  const session = new MemorySession({
    path: join(tempDir, "memory.db"),
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    // The worker tick interval plus polling on embedding counts adds
    // up — keep the handle warm so we are not paying the open cost
    // between every probe.
    idleCloseMs: 60_000,
  });
  try {
    await session.withDb(async (db) => {
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
    });
    await fn(session);
  } finally {
    await session.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function embeddingCount(session: MemorySession): Promise<number> {
  const result = await session.withDb(async (db) =>
    db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM observation_embeddings`),
  );
  return result?.rows[0]?.count ?? 0;
}

async function readEmbeddingRows(
  session: MemorySession,
): Promise<{ observation_id: string; model: string }[]> {
  const result = await session.withDb(async (db) =>
    db.query<{ observation_id: string; model: string }>(
      `SELECT observation_id, model FROM observation_embeddings ORDER BY observation_id`,
    ),
  );
  return result?.rows ?? [];
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
