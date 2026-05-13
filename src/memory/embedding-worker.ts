import type { PGlite, Transaction } from "@electric-sql/pglite";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedFn } from "./embedding.js";
import type { MemorySession } from "./session.js";

/**
 * Background worker that fills missing embeddings while the CLI is
 * running. Started by `loadStoredMemory()`, stopped on dispose. Never
 * blocks a turn: the observer/reflector can write a new row and return
 * to the user immediately; the embedding lands within a few seconds in
 * the background, after which the row becomes hybrid-retrievable.
 *
 * Tick shape:
 *   1. Acquire the memory session via one `withDb`. Inside that open,
 *      drain unembedded rows in `BATCH_SIZE` chunks until a select
 *      returns zero rows, then exit `withDb` so the cross-process lock
 *      releases shortly after via the session's idle-close timer.
 *   2. Sleep `IDLE_SLEEP_MS` between ticks. Long enough that a peer
 *      duet CLI can acquire the lock between drains, short enough that
 *      a newly-written observation becomes searchable within seconds.
 *   3. On error (rate limit, transient network), back off for
 *      `ERROR_SLEEP_MS` before retrying.
 *
 * Failure modes are local: any error inside the loop logs and resumes
 * after a backoff. The worker never throws to the caller.
 */
const BATCH_SIZE = 50;
const DEFAULT_IDLE_SLEEP_MS = 10_000;
const DEFAULT_ERROR_SLEEP_MS = 60_000;
// Cap how often a single observation may be re-embedded. The production
// memory store can churn rows (the reflector deletes and re-inserts a
// session's observations, which cascade-deletes their embeddings). If
// the embedding row vanishes between drains we should re-embed at
// most once per cooldown rather than running an unbounded hot loop
// over the same ids.
const DEFAULT_ATTEMPT_COOLDOWN_MS = 5 * 60_000;
// Snippet length for embedding-failure log lines. The remote endpoint
// occasionally responds with a full HTML page when misrouted (404 from
// the marketing site) and dumping the whole body fills the log with
// tens of kilobytes per failure.
const ERROR_BODY_LOG_MAX = 200;

export interface EmbeddingBackfillWorkerOptions {
  /** Memory session owning the PGlite handle and cross-process lock. */
  session: MemorySession;
  /** Embedding callable. Defaults to the gateway client; tests inject a stub. */
  embed: EmbedFn;
  /** Path to append progress lines to. Optional; when omitted the worker logs nothing. */
  logPath?: string;
  /**
   * Idle delay between outer drain ticks in milliseconds. Defaults to
   * 10s, which gives a peer duet CLI room to acquire the lock between
   * drains. Tests override this to drive several ticks per second.
   */
  idleSleepMs?: number;
  /**
   * Backoff after a failed drain in milliseconds. Defaults to 60s.
   * Tests override this so a transient-error case does not block the
   * suite for a full minute.
   */
  errorSleepMs?: number;
  /**
   * Minimum time between re-embed attempts for the same observation
   * id, in milliseconds. Defaults to 5 minutes. Caps unbounded
   * re-embedding when something (typically the reflector's
   * delete-and-reinsert cycle) keeps wiping a row's embedding behind
   * the worker's back.
   */
  attemptCooldownMs?: number;
  /**
   * Maximum size of the live log file in bytes before it is rotated
   * to `<logPath>.1` (replacing any prior rotation). Defaults to 1 MB.
   * Each call to `log` checks the current size first and rotates
   * before appending, so a chronic failure cannot grow the log without
   * bound.
   */
  logMaxBytes?: number;
}

const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

export class EmbeddingBackfillWorker {
  private readonly options: EmbeddingBackfillWorkerOptions;
  private readonly idleSleepMs: number;
  private readonly errorSleepMs: number;
  private readonly attemptCooldownMs: number;
  private readonly logMaxBytes: number;
  // Per-id record of the last attempt timestamp. selectBatch filters
  // out ids attempted within the cooldown, breaking the hot loop when
  // a row's embedding keeps disappearing between drains. Entries are
  // purged lazily as they expire.
  private readonly recentAttempts = new Map<string, number>();
  private abortController?: AbortController;
  private runningPromise?: Promise<void>;

  constructor(options: EmbeddingBackfillWorkerOptions) {
    this.options = options;
    this.idleSleepMs = options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
    this.errorSleepMs = options.errorSleepMs ?? DEFAULT_ERROR_SLEEP_MS;
    this.attemptCooldownMs = options.attemptCooldownMs ?? DEFAULT_ATTEMPT_COOLDOWN_MS;
    this.logMaxBytes = options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
  }

  /** Start the background loop. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.runningPromise) return;
    this.abortController = new AbortController();
    this.runningPromise = this.run(this.abortController.signal);
  }

  /**
   * Stop the loop and wait for the in-flight tick (if any) to settle.
   * Because each tick awaits a `session.withDb`, this transitively waits
   * for any open the worker holds to drain and the lock to release.
   */
  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.runningPromise;
    this.abortController = undefined;
    this.runningPromise = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        // One withDb per tick: drain everything that's currently
        // outstanding while we hold the lock, then exit so the
        // session can idle-close and another duet CLI can take a
        // turn. A returned `undefined` means the lock could not be
        // acquired in time — fall through to the idle sleep and
        // retry the same tick later.
        await this.options.session.withDb(async (db) => {
          while (!signal.aborted) {
            const batch = await this.selectBatch(db);
            if (batch.length === 0) return;
            // Stamp the attempt before we await the embedding so a
            // failure mid-call still counts as an attempt and the same
            // ids do not get retried in a tight loop on the next drain.
            const attemptAt = Date.now();
            for (const row of batch) this.recentAttempts.set(row.id, attemptAt);
            const result = await this.options.embed(batch.map((row) => row.content));
            if (result.embeddings.length !== batch.length) {
              throw new Error(
                `Embedding response length (${result.embeddings.length}) did not match batch size (${batch.length})`,
              );
            }
            await this.persistBatch(db, batch, result.embeddings, result.model);
            this.log(`Embedded ${batch.length} observations`);
          }
        });
        if (signal.aborted) return;
        await sleep(this.idleSleepMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.log(`Embedding batch failed: ${summarizeError(error)}`);
        await sleep(this.errorSleepMs, signal);
      }
    }
  }

  private async selectBatch(db: PGlite): Promise<{ id: string; content: string }[]> {
    // LEFT JOIN over the embeddings table is the cheapest way to pick
    // rows with no embedding yet. The composite index on
    // (kind, priority, created_at DESC) carries the ORDER BY without a
    // separate sort.
    //
    // The exclusion list comes from `recentAttempts` and caps how
    // often the worker may retry the same id, even if its embedding
    // row keeps being cascade-deleted between drains.
    const excludedIds = this.collectCooledIds();
    const result = await db.query<{ id: string; content: string }>(
      `SELECT o.id, o.content
       FROM observations o
       LEFT JOIN observation_embeddings e ON e.observation_id = o.id
       WHERE e.observation_id IS NULL
         AND NOT (o.id = ANY($2::text[]))
       ORDER BY
         CASE o.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         o.created_at DESC
       LIMIT $1`,
      [BATCH_SIZE, excludedIds],
    );
    return result.rows;
  }

  /**
   * Return the ids currently inside the attempt-cooldown window and
   * forget anything older so the map cannot grow unbounded.
   */
  private collectCooledIds(): string[] {
    const now = Date.now();
    const cutoff = now - this.attemptCooldownMs;
    const active: string[] = [];
    for (const [id, at] of this.recentAttempts) {
      if (at < cutoff) {
        this.recentAttempts.delete(id);
        continue;
      }
      active.push(id);
    }
    return active;
  }

  private async persistBatch(
    db: PGlite,
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
    await db.transaction(async (tx: Transaction) => {
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
    const logPath = this.options.logPath;
    if (!logPath) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      // Rotate before appending so the live file never exceeds the
      // cap by more than one line. The single `.1` rotation keeps the
      // most recent overflow available for post-mortem without
      // accumulating an unbounded ring of files.
      try {
        if (statSync(logPath).size >= this.logMaxBytes) {
          renameSync(logPath, `${logPath}.1`);
        }
      } catch {
        // No existing file or stat failed; appendFileSync will create.
      }
      // Include the pid so multi-CLI runs (which share the log file
      // via the same HOME-backed `.duet/logs/` path) can be
      // disambiguated. Each appendFileSync call writes a single line
      // well under PIPE_BUF, so O_APPEND keeps lines from different
      // processes intact even when they interleave.
      appendFileSync(
        logPath,
        `[${new Date().toISOString()} pid=${process.pid}] ${message}\n`,
        "utf8",
      );
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

/**
 * Render an error for the worker log without dumping multi-kilobyte
 * HTML bodies. The embedding endpoint can respond with a full Next.js
 * 404 page (over 50KB) when misrouted, and the raw message would
 * otherwise be appended verbatim on every retry.
 */
function summarizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const collapsed = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= ERROR_BODY_LOG_MAX) return collapsed;
  return `${collapsed.slice(0, ERROR_BODY_LOG_MAX)}… (truncated ${collapsed.length - ERROR_BODY_LOG_MAX} chars)`;
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
