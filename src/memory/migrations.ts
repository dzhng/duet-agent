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
  {
    version: 2,
    description: "add session_id, kind; drop scope; flatten tool source into tag",
    up: async (tx) => {
      // Schema reshape for the cross-session memory layer.
      //
      //   - session_id NULL-allowed: identifies which session created the
      //     row. NULL means "created before sessionId tracking existed";
      //     loaders treat NULL the same as any non-current session
      //     (always global-eligible, never local-eligible). New rows
      //     always set it once the runner is plumbed in commit 3.
      //
      //   - kind: "observation" vs "reflection". Reflections rank higher
      //     by default (reflectionBias multiplier in the loader) because
      //     they are condensed cross-observation summaries. Backfilled
      //     from tags_json since the existing reflector tags its output
      //     with `["observational-memory","reflection"]`.
      //
      //   - scope dropped: the session/resource axis is replaced by
      //     `session_id matches current session?`, which is what callers
      //     actually wanted. "resource" scope was never wired through to
      //     a real query path.
      //
      //   - source_json reshape: drop the `{kind:"tool",toolName:X}`
      //     variant and lift toolName into tags as `tool:X`. Tool
      //     provenance becomes searchable by tag, and the source enum
      //     tightens to user|agent|system. Idempotent: rows already
      //     reshaped (or never tool-sourced) pass through unchanged.
      await tx.exec(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS session_id TEXT`);
      await tx.exec(
        `ALTER TABLE observations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'observation'`,
      );

      // Backfill kind from existing tag convention before we trust the
      // column for queries.
      await tx.exec(
        `UPDATE observations
         SET kind = 'reflection'
         WHERE kind = 'observation' AND tags_json LIKE '%"reflection"%'`,
      );

      // Reshape source_json + tags_json for legacy tool rows. Done in JS
      // because PGlite has no native JSON manipulation that handles the
      // tags-array merge cleanly.
      const toolRows = await tx.query<{ id: string; source_json: string; tags_json: string }>(
        `SELECT id, source_json, tags_json
         FROM observations
         WHERE source_json LIKE '%"kind":"tool"%'`,
      );
      for (const row of toolRows.rows) {
        let parsedSource: { kind?: string; toolName?: string } = {};
        try {
          parsedSource = JSON.parse(row.source_json) as typeof parsedSource;
        } catch {
          // Malformed JSON predates this code; leave the row alone rather
          // than guessing.
          continue;
        }
        if (parsedSource.kind !== "tool") continue;

        let parsedTags: string[] = [];
        try {
          parsedTags = JSON.parse(row.tags_json) as string[];
        } catch {
          parsedTags = [];
        }
        const toolTag = parsedSource.toolName ? `tool:${parsedSource.toolName}` : undefined;
        const nextTags =
          toolTag && !parsedTags.includes(toolTag) ? [...parsedTags, toolTag] : parsedTags;

        await tx.query(`UPDATE observations SET source_json = $1, tags_json = $2 WHERE id = $3`, [
          JSON.stringify({ kind: "agent" }),
          JSON.stringify(nextTags),
          row.id,
        ]);
      }

      await tx.exec(`ALTER TABLE observations DROP COLUMN IF EXISTS scope`);

      // Indexes for the new query patterns: session-scoped local lookup
      // and (priority, recency)-ranked global lookup. Composite index
      // matches the loader's ORDER BY shape so the planner can avoid a
      // sort on hot paths.
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_obs_session_id ON observations(session_id)`);
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_kind_priority_created
         ON observations(kind, priority, created_at DESC)`,
      );
    },
  },
  {
    version: 3,
    description: "pgvector embeddings table and tsvector keyword index",
    up: async (tx) => {
      // Hybrid retrieval (recall_memory tool) needs two indexes side by
      // side: a vector index for semantic similarity and a tsvector GIN
      // index for keyword matches. Reciprocal Rank Fusion in the tool
      // merges both ranked lists; one without the other misses the
      // class of queries the other catches (proper-noun lookups for
      // keyword, fuzzy paraphrases for vector).
      //
      // pgvector itself is loaded as a PGlite extension at construction
      // time (see memory/pglite.ts); CREATE EXTENSION is the SQL-level
      // hook that activates the type and operator definitions.
      await tx.exec(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Embeddings live in a sibling table rather than a column on
      // observations because (a) embeddings are written asynchronously
      // by the backfill worker, often well after the observation row
      // lands, and (b) the embedding model may change in the future
      // without forcing every existing row to re-embed in lockstep.
      // The `model` column records which model produced each vector
      // so a future re-embedding pass can selectively replace stale
      // entries.
      //
      // Dimension 1536 matches OpenAI text-embedding-3-small (the
      // model exposed by the Duet embedding endpoint). Switching to a
      // different dimension means a new migration that drops and
      // rebuilds this table; the dimension is part of the column type.
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS observation_embeddings (
          observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          vector vector(1536) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);

      // HNSW is the right default for memory-scale corpora (typical
      // user has thousands, not millions, of observations): build is
      // fast, query is sub-millisecond, recall is high. Cosine
      // operator class matches the recall_memory tool's similarity
      // metric.
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_emb_hnsw
         ON observation_embeddings USING hnsw (vector vector_cosine_ops)`,
      );

      // GIN index on a generated tsvector lets the keyword path of
      // hybrid retrieval run in milliseconds without per-query
      // tokenization overhead. English config is a reasonable default;
      // multi-language support can swap in `simple` later.
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_content_fts
         ON observations USING gin (to_tsvector('english', content))`,
      );
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
