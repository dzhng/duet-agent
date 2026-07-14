import type { PGlite } from "@electric-sql/pglite";
import { observationScore, PRIORITY_WEIGHT } from "../memory/loader.js";
import { runMigrations } from "../memory/migrations.js";
import {
  DEFAULT_MANUAL_BIAS,
  DEFAULT_NOTE_BIAS,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  DEFAULT_REFLECTION_BIAS,
} from "../memory/observational.js";
import {
  DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS,
  MemoryLockTimeoutError,
  openPGliteWaitingForLock,
} from "../memory/pglite.js";
import { MemorySession } from "../memory/session.js";
import { archivedFilePath, readArchiveManifest, removeArchive } from "../train/archive.js";
import { isTrainTagged, slugFromTags } from "../train/tags.js";
import type { TrainListEntry, TrainManifest, TrainRecord } from "../train/types.js";
import type { Observation, ObservationSource } from "../types/memory.js";
import { fail } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

/**
 * Report an exhausted memory-DB open lock and exit `75` (the contract's
 * distinguished lock-wait code, distinct from a generic runtime failure).
 * Every memory/train subcommand funnels its {@link MemoryLockTimeoutError}
 * here so the friendly, actionable message and the exit code stay identical.
 */
export function failMemoryLockTimeout(error: MemoryLockTimeoutError): never {
  return fail(
    `Memory database at ${error.dataDir} is still locked by duet pid ${error.holderPid} after ${
      error.budgetMs / 1000
    }s. Stop that process (or pass --wait <seconds> to wait longer) and retry.`,
    75,
  );
}

/** Rows fetched per page by the ranked, lazily-paginated TUI list. */
export const MEMORY_PAGE_SIZE = 25;

export interface MemoryQueryFilters {
  kind?: Observation["kind"];
  priority?: Observation["priority"];
  source?: ObservationSource["kind"];
  /** Restrict to rows authored by this session (matches `session_id`). */
  sessionId?: string;
  fromMs?: number;
  toMs?: number;
}

/**
 * Absolute global-pack score for one observation under the CLI defaults.
 * Reuses the shared {@link observationScore} formula but layers the manual
 * multiplier on top — `observationScore` only applies `reflectionBias`, so
 * calling it directly would under-report curated/manual rows by the manual
 * multiplier. The runner's `loadGlobalPack` applies `manualBias` to
 * `kind === "manual"` as a separate factor, and the value surfaced here must
 * match that ranking so the TUI ordering and the per-row score number agree
 * with the runtime ranking across every kind, including manual rows.
 */
export function scoreObservation(observation: Observation, now: number = Date.now()): number {
  return observationScore(observation, now, {
    recencyHalfLifeMs: DEFAULT_RECENCY_HALF_LIFE_MS,
    reflectionBias: DEFAULT_REFLECTION_BIAS,
    manualBias: DEFAULT_MANUAL_BIAS,
    noteBias: DEFAULT_NOTE_BIAS,
  });
}

/**
 * Thin read/edit/delete wrapper over the PGlite database the memory pipeline writes
 * to. The `duet memory` command opens the same on-disk file, so changes
 * made here are visible to subsequent runner sessions.
 */
export class MemoryDb {
  private constructor(private readonly db: PGlite) {}

  /**
   * Open the memory database at `path`, creating the file and parent
   * directory if needed. The schema is shared with `memory/storage.ts` so
   * the runner and this CLI command stay in sync.
   *
   * `waitBudgetMs` controls how long to poll the cross-process open-lock when a peer duet
   * process is holding it before throwing `MemoryLockTimeoutError`. Defaults to
   * `DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS` so `duet memory` rides out brief contention with a
   * concurrent runner session instead of failing on first try.
   */
  static async open(
    path: string,
    { waitBudgetMs = DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS }: { waitBudgetMs?: number } = {},
  ): Promise<MemoryDb> {
    // Both the runner (`memory/storage.ts`) and this CLI command open the
    // same on-disk database, so both must apply migrations on open.
    // Whichever process touches the file first wins the upgrade race;
    // the other observes a no-op since `runMigrations` is idempotent.
    const db = await openPGliteWaitingForLock(
      path,
      {
        init: async (instance) => {
          await runMigrations(instance);
        },
      },
      waitBudgetMs,
    );
    return new MemoryDb(db);
  }

  /** Total number of observations across every session. */
  async count(): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM observations`,
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Load one page of observations as a single flat list across every session,
   * ordered by descending global-pack score (highest first). The ORDER BY
   * materializes the exact score {@link observationScore} computes —
   * `priorityWeight * 0.5^((now - lastUsedAt)/halfLife) * kindBias` — so the
   * row order always agrees with the score number the TUI renders per row.
   *
   * `now` is passed in (not read from SQL `now()`) so it stays fixed across
   * every page fetch in a TUI session: pagination with LIMIT/OFFSET is only
   * stable if the sort key does not drift between calls, and the displayed
   * score must use the same `now`. Paged with LIMIT/OFFSET so the TUI lazily
   * fetches and appends pages instead of loading the whole table up front.
   */
  async listRanked({
    limit,
    offset,
    now = Date.now(),
  }: {
    limit: number;
    offset: number;
    now?: number;
  }): Promise<Observation[]> {
    const result = await this.db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
              time_of_day, priority, source_json, content, tags_json
       FROM observations
       ORDER BY
         (CASE priority WHEN 'high' THEN $1::float
                        WHEN 'medium' THEN $2::float
                        ELSE $3::float END)
         * power(0.5::float, ($8::float - last_used_at::float) / $7::float)
         * (CASE kind WHEN 'reflection' THEN $4::float
                      WHEN 'manual' THEN $5::float
                      WHEN 'note' THEN $6::float
                      ELSE 1.0 END)
         DESC,
         created_at DESC,
         id ASC
       LIMIT $9 OFFSET $10`,
      [
        PRIORITY_WEIGHT.high,
        PRIORITY_WEIGHT.medium,
        PRIORITY_WEIGHT.low,
        DEFAULT_REFLECTION_BIAS,
        DEFAULT_MANUAL_BIAS,
        DEFAULT_NOTE_BIAS,
        DEFAULT_RECENCY_HALF_LIFE_MS,
        now,
        limit,
        offset,
      ],
    );
    return result.rows.map(rowToObservation);
  }

  /** Query observations newest-first with the optional `duet memory` query filters. */
  async queryObservations(filters: MemoryQueryFilters = {}): Promise<Observation[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (clause: string, value: unknown): void => {
      params.push(value);
      conditions.push(clause.replace("$?", `$${params.length}`));
    };
    if (filters.kind !== undefined) bind("kind = $?", filters.kind);
    if (filters.priority !== undefined) bind("priority = $?", filters.priority);
    if (filters.source !== undefined) bind("(source_json::json->>'kind') = $?", filters.source);
    if (filters.sessionId !== undefined) bind("session_id = $?", filters.sessionId);
    if (filters.fromMs !== undefined) bind("created_at >= $?", filters.fromMs);
    if (filters.toMs !== undefined) bind("created_at <= $?", filters.toMs);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
              time_of_day, priority, source_json, content, tags_json
       FROM observations
       ${where}
       ORDER BY created_at DESC, id ASC`,
      params,
    );
    return result.rows.map(rowToObservation);
  }

  /**
   * Every `duet train` row (those tagged `train`), newest-first, joined to its
   * archive manifest for headline/model/provenance. Backs `duet train list`.
   */
  async listTrainings(): Promise<TrainListEntry[]> {
    const observations = await this.readTrainObservations();
    const entries = await Promise.all(
      observations.map(async (row) => this.toTrainEntry(row, await readArchiveManifest(row.id))),
    );
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return entries;
  }

  /**
   * Resolve a slug to its single training row plus the synthesized content,
   * or `undefined` when no row carries `train:<slug>`. Backs `duet train
   * show`, `update`, and `delete`, which all key on the user-facing slug
   * rather than the internal observation id.
   */
  async findTrainingBySlug(slug: string): Promise<TrainRecord | undefined> {
    const observations = await this.readTrainObservations();
    const row = observations.find((observation) => slugFromTags(observation.tags) === slug);
    if (!row) return undefined;
    const manifest = await readArchiveManifest(row.id);
    return {
      ...this.toTrainEntry(row, manifest),
      content: row.content,
      files: manifest?.files.map((file) => archivedFilePath(row.id, file.relPath)),
    };
  }

  private async readTrainObservations(): Promise<Observation[]> {
    const result = await this.db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations`,
    );
    return result.rows
      .map(rowToObservation)
      .filter((observation) => isTrainTagged(observation.tags));
  }

  private toTrainEntry(
    observation: Observation,
    manifest: TrainManifest | undefined,
  ): TrainListEntry {
    return {
      slug: slugFromTags(observation.tags) ?? "(unknown)",
      memoryId: observation.id,
      createdAt: observation.createdAt,
      observedDate: observation.observedDate,
      headline: manifest?.headline,
      model: manifest?.model,
      sourceFolder: manifest?.sourceFolder,
      fileCount: manifest?.files.length,
      hasArchive: manifest !== undefined,
    };
  }

  /** Replace just the `content` of an observation, preserving everything else. */
  async updateContent(id: string, content: string): Promise<void> {
    await this.db.query(`UPDATE observations SET content = $1 WHERE id = $2`, [content, id]);
  }

  /**
   * Permanently remove an observation. There is no undo. Rows written by
   * `duet train` keep a corpus archive under `~/.duet/train/<id>/` that
   * shares the row's lifecycle, so it is removed too (a no-op for every
   * other row — there is simply no directory to delete).
   */
  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM observations WHERE id = $1`, [id]);
    await removeArchive(id);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * Open the memory database for a one-shot CLI subcommand, run `fn`, and always
 * close it. Cross-process lock contention surfaces as the same friendly,
 * actionable message every memory/train subcommand uses rather than a raw
 * error. Shared by `duet train` management commands and `duet memory` queries.
 */
export async function withMemoryDb<T>(
  dbPath: string,
  fn: (db: MemoryDb) => Promise<T>,
  { waitBudgetMs }: { waitBudgetMs?: number } = {},
): Promise<T> {
  let db: MemoryDb;
  try {
    db = await MemoryDb.open(dbPath, { waitBudgetMs });
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      failMemoryLockTimeout(error);
    }
    throw error;
  }
  const removeShutdownHandlers = installShutdownHandlers(() => db.close());
  try {
    return await fn(db);
  } finally {
    removeShutdownHandlers();
    await db.close();
  }
}

/**
 * Run `fn` against a {@link MemorySession} opened on the shared memory
 * database — the entry point for one-shot CLI commands that need the
 * session's refcounted handle and cross-process lock (writes via
 * `appendObservation`, hybrid recall) rather than the raw {@link MemoryDb}
 * query wrapper. Applies migrations on open, installs shutdown handlers, and
 * always disposes; a lock-contention timeout exits `75` via
 * {@link failMemoryLockTimeout} so callers share one error message and code.
 */
export async function withMemorySession<T>(
  dbPath: string,
  fn: (session: MemorySession) => Promise<T>,
  { waitBudgetMs }: { waitBudgetMs?: number } = {},
): Promise<T> {
  const session = new MemorySession({
    path: dbPath,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    ...(waitBudgetMs !== undefined ? { lockWaitBudgetMs: waitBudgetMs } : {}),
    idleCloseMs: 60_000,
  });
  const removeShutdownHandlers = installShutdownHandlers(() => session.dispose());
  try {
    return await fn(session);
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      failMemoryLockTimeout(error);
    }
    throw error;
  } finally {
    removeShutdownHandlers();
    await session.dispose();
  }
}

interface ObservationRow {
  id: string;
  created_at: number;
  last_used_at: number;
  session_id: string | null;
  kind: Observation["kind"];
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: Observation["priority"];
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
