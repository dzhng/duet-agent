/**
 * Schema for the persisted observational memory database. Used by both the
 * runner (`memory/storage.ts`) and the `duet memory` CLI (`cli/memory-db.ts`)
 * so the two stay in sync.
 */
export const OBSERVATIONS_SCHEMA_SQL = `
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
  );
`;
