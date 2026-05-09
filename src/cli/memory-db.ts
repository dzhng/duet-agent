import type { PGlite } from "@electric-sql/pglite";
import { openPGlite } from "../memory/pglite.js";
import { OBSERVATIONS_SCHEMA_SQL } from "../memory/schema.js";
import type { Observation } from "../types/memory.js";

/**
 * Thin read/edit/delete wrapper over the PGlite database `MemoryStore` writes
 * to. The `duet memory` command opens the same on-disk file, so changes
 * made here are visible to subsequent runner sessions.
 */
export class MemoryDb {
  private constructor(private readonly db: PGlite) {}

  /**
   * Open the memory database at `path`, creating the file and parent
   * directory if needed. The schema is shared with `memory/storage.ts` so
   * the runner and this CLI command stay in sync.
   */
  static async open(path: string): Promise<MemoryDb> {
    const db = await openPGlite(path, { schemaSql: OBSERVATIONS_SCHEMA_SQL });
    return new MemoryDb(db);
  }

  /** Load all observations ordered most recent first. */
  async list(): Promise<Observation[]> {
    const result = await this.db.query<ObservationRow>(
      `SELECT id, created_at, observed_date, referenced_date, relative_date, time_of_day,
              priority, scope, source_json, content, tags_json
       FROM observations
       ORDER BY created_at DESC`,
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
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: Observation["priority"];
  scope: Observation["scope"];
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    scope: row.scope,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
