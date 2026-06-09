import type { PGlite } from "@electric-sql/pglite";
import { observationScore, PRIORITY_WEIGHT } from "../memory/loader.js";
import { runMigrations } from "../memory/migrations.js";
import { DEFAULT_RECENCY_HALF_LIFE_MS, DEFAULT_REFLECTION_BIAS } from "../memory/observational.js";
import { DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS, openPGliteWaitingForLock } from "../memory/pglite.js";
import type { Observation } from "../types/memory.js";

/** Rows fetched per page by the ranked, lazily-paginated TUI list. */
export const MEMORY_PAGE_SIZE = 25;

/**
 * Absolute global-pack score for one observation under the CLI defaults.
 * Reuses the shared {@link observationScore} formula so the displayed value
 * tracks the runner's ranking exactly. Hardcoded to the runner's global-pack
 * defaults so the TUI ordering and the per-row score number match what the
 * runtime ranking would produce (loader.ts), with no flags to drift out of sync.
 */
export function scoreObservation(observation: Observation, now: number = Date.now()): number {
  return observationScore(observation, now, {
    recencyHalfLifeMs: DEFAULT_RECENCY_HALF_LIFE_MS,
    reflectionBias: DEFAULT_REFLECTION_BIAS,
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
         * power(0.5::float, ($6::float - last_used_at::float) / $5::float)
         * (CASE kind WHEN 'reflection' THEN $4::float ELSE 1.0 END)
         DESC,
         created_at DESC,
         id ASC
       LIMIT $7 OFFSET $8`,
      [
        PRIORITY_WEIGHT.high,
        PRIORITY_WEIGHT.medium,
        PRIORITY_WEIGHT.low,
        DEFAULT_REFLECTION_BIAS,
        DEFAULT_RECENCY_HALF_LIFE_MS,
        now,
        limit,
        offset,
      ],
    );
    return result.rows.map(rowToObservation);
  }

  /** Replace just the `content` of an observation, preserving everything else. */
  async updateContent(id: string, content: string): Promise<void> {
    await this.db.query(`UPDATE observations SET content = $1 WHERE id = $2`, [content, id]);
  }

  /** Permanently remove an observation. There is no undo. */
  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM observations WHERE id = $1`, [id]);
  }

  async close(): Promise<void> {
    await this.db.close();
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
