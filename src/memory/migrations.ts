import type { PGlite, Transaction } from "@electric-sql/pglite";

/**
 * Forward-only schema migrations for the observational memory database.
 *
 * Why a real migration framework instead of `CREATE TABLE IF NOT EXISTS`:
 * the memory schema is changing shape (adding `session_id` and `kind`,
 * dropping `scope`, reshaping `source_json`) and the existing
 * `OBSERVATIONS_SCHEMA_SQL` probe cannot express any of that. A user
 * upgrading Duet must have their existing rows transformed in place —
 * dropping the column without rewriting the data would lose information,
 * and there is no `duet memory migrate` CLI step we want to require.
 *
 * Design notes:
 *   - Migrations run inside `loadStoredMemory()` and `MemoryDb.open()` so
 *     both the runner and the `duet memory` CLI see the same upgraded
 *     schema. Failure aborts startup with a clear message; the underlying
 *     PGlite directory is also covered by `quarantineDataDirectory()` for
 *     unreadable cases (see `pglite.ts`).
 *   - Each migration runs inside a single transaction. Postgres DDL is
 *     transactional, so a partial failure rolls back to the prior version.
 *   - The `schema_version` table records every applied migration with its
 *     wall-clock timestamp. This is read once on open to find the current
 *     version; we never go backwards.
 *   - Forward-only by design. A bad migration is fixed by writing the next
 *     migration, not by reverting. This matches gbrain's pattern after
 *     they hit "upgrade-wedge" bugs across six schema versions.
 */
export interface Migration {
  /** Monotonic version number. Migrations are applied strictly in ascending order. */
  version: number;
  /** One-line summary stored in `schema_version.description` for audit. */
  description: string;
  /** Forward step. Receives a transaction so DDL + DML run atomically. */
  up: (tx: Transaction) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial observations schema",
    up: async (tx) => {
      // Snapshot of the schema that shipped before migrations existed.
      // Idempotent so brand-new installs and pre-migration brains both
      // converge on the same baseline before later migrations run.
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          created_at BIGINT NOT NULL,
          observed_date TEXT NOT NULL,
          referenced_date TEXT,
          relative_date TEXT,
          time_of_day TEXT,
          priority TEXT NOT NULL,
          scope TEXT NOT NULL,
          source_json TEXT NOT NULL,
          content TEXT NOT NULL,
          tags_json TEXT NOT NULL
        )
      `);
    },
  },
];

export interface MigrationResult {
  /** Schema version the database was at before `runMigrations` was called. */
  fromVersion: number;
  /** Schema version the database is at after `runMigrations` returns. */
  toVersion: number;
  /** Versions actually applied this call (empty when already up to date). */
  applied: number[];
}

/**
 * Bring the database up to the latest known schema version. Idempotent;
 * safe to call on every open. Throws on the first failure with the
 * triggering migration's version in the message so users have a place to
 * look without grepping.
 */
export async function runMigrations(db: PGlite): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL,
      description TEXT NOT NULL
    )
  `);

  const result = await db.query<{ max: number | null }>(
    "SELECT MAX(version) AS max FROM schema_version",
  );
  const fromVersion = result.rows[0]?.max ?? 0;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    try {
      await db.transaction(async (tx) => {
        await migration.up(tx);
        await tx.query(
          "INSERT INTO schema_version (version, applied_at, description) VALUES ($1, $2, $3)",
          [migration.version, Date.now(), migration.description],
        );
      });
      applied.push(migration.version);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Memory schema migration v${migration.version} (${migration.description}) failed: ${reason}. ` +
          "The database was rolled back to the previous version; rerun once the cause is fixed.",
      );
    }
  }

  return {
    fromVersion,
    toVersion: applied.at(-1) ?? fromVersion,
    applied,
  };
}

/** Latest version known to this build. Exported for tests. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/** All registered migrations. Exported for tests. */
export const REGISTERED_MIGRATIONS: readonly Migration[] = MIGRATIONS;
