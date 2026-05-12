import type { PGlite } from "@electric-sql/pglite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedFn } from "./embedding.js";

/**
 * Background worker that fills missing embeddings while the CLI is
 * running. Started by `loadStoredMemory()`, stopped on dispose. Never
 * blocks a turn: the observer/reflector can write a new row and return
 * to the user immediately; the embedding lands within a few seconds in
 * the background, after which the row becomes hybrid-retrievable.
 *
 * Loop shape:
 *   1. Select up to BATCH_SIZE unembedded rows, prioritized by
 *      `priority DESC, created_at DESC` so high-signal recent
 *      observations become searchable first.
 *   2. Embed via the gateway client.
 *   3. Write the resulting vectors back.
 *   4. Sleep briefly between batches so the worker stays out of the
 *      runtime's way; sleep longer when idle (no work) or after an
 *      error (rate limit, transient network).
 *
 * Failure modes are local: any error inside the loop logs and resumes
 * after a backoff. The worker never throws to the caller.
 */
const BATCH_SIZE = 50;
const INTER_BATCH_SLEEP_MS = 500;
const IDLE_SLEEP_MS = 30_000;
const ERROR_SLEEP_MS = 60_000;

export interface EmbeddingBackfillWorkerOptions {
  db: PGlite;
  /** Embedding callable. Defaults to the gateway client; tests inject a stub. */
  embed: EmbedFn;
  /** Path to append progress lines to. Optional; when omitted the worker logs nothing. */
  logPath?: string;
}

export class EmbeddingBackfillWorker {
  private readonly options: EmbeddingBackfillWorkerOptions;
  private abortController?: AbortController;
  private runningPromise?: Promise<void>;

  constructor(options: EmbeddingBackfillWorkerOptions) {
    this.options = options;
  }

  /** Start the background loop. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.runningPromise) return;
    this.abortController = new AbortController();
    this.runningPromise = this.run(this.abortController.signal);
  }

  /** Stop the loop and wait for the in-flight batch (if any) to settle. */
  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.runningPromise;
    this.abortController = undefined;
    this.runningPromise = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const batch = await this.selectBatch();
        if (batch.length === 0) {
          await sleep(IDLE_SLEEP_MS, signal);
          continue;
        }

        const result = await this.options.embed(batch.map((row) => row.content));
        if (result.embeddings.length !== batch.length) {
          throw new Error(
            `Embedding response length (${result.embeddings.length}) did not match batch size (${batch.length})`,
          );
        }

        await this.persistBatch(batch, result.embeddings, result.model);
        this.log(`Embedded ${batch.length} observations`);
        await sleep(INTER_BATCH_SLEEP_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`Embedding batch failed: ${reason}`);
        await sleep(ERROR_SLEEP_MS, signal);
      }
    }
  }

  private async selectBatch(): Promise<{ id: string; content: string }[]> {
    // LEFT JOIN over the embeddings table is the cheapest way to pick
    // rows with no embedding yet. The composite index on
    // (kind, priority, created_at DESC) carries the ORDER BY without a
    // separate sort.
    const result = await this.options.db.query<{ id: string; content: string }>(
      `SELECT o.id, o.content
       FROM observations o
       LEFT JOIN observation_embeddings e ON e.observation_id = o.id
       WHERE e.observation_id IS NULL
       ORDER BY
         CASE o.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         o.created_at DESC
       LIMIT $1`,
      [BATCH_SIZE],
    );
    return result.rows;
  }

  private async persistBatch(
    batch: { id: string; content: string }[],
    vectors: number[][],
    model: string,
  ): Promise<void> {
    // One transaction so a partial network or write failure does not
    // leave the embeddings table half-populated relative to the
    // candidate set we just queried. `model` is the identifier the
    // server reported for this batch; storing it verbatim lets a
    // future re-embedding pass match the deprecated tag and refresh
    // only the affected rows.
    //
    // The `INSERT ... SELECT ... WHERE EXISTS` filter avoids a FK race:
    // between `selectBatch` and `persistBatch` the reflector may have
    // called `replaceSessionObservations`, which deletes the parent
    // row. A bare `INSERT` would then abort the whole transaction with
    // a foreign-key violation, losing every embedding in this batch.
    // Skipping the missing parent inserts 0 rows for that observation
    // and lets the surviving rows commit.
    await this.options.db.transaction(async (tx) => {
      const now = Date.now();
      for (let index = 0; index < batch.length; index++) {
        const row = batch[index]!;
        const vector = vectors[index]!;
        await tx.query(
          `INSERT INTO observation_embeddings (observation_id, model, vector, created_at)
           SELECT $1, $2, $3::vector, $4
           WHERE EXISTS (SELECT 1 FROM observations WHERE id = $1)
           ON CONFLICT (observation_id) DO UPDATE SET
             model = EXCLUDED.model,
             vector = EXCLUDED.vector,
             created_at = EXCLUDED.created_at`,
          [row.id, model, formatVector(vector), now],
        );
      }
    });
  }

  private log(message: string): void {
    if (!this.options.logPath) return;
    try {
      mkdirSync(dirname(this.options.logPath), { recursive: true });
      appendFileSync(this.options.logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
    } catch {
      // Logging is best-effort; failures here must not bring the worker
      // down. The next batch's logs will retry the directory create.
    }
  }
}

/**
 * pgvector accepts text-format literals like `[1,2,3]` for INSERT.
 * Using the text path keeps us off the binary protocol that PGlite's
 * client surface does not expose for vectors.
 */
function formatVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
