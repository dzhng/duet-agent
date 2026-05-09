/**
 * Lightweight connectivity probe run by `openPGlite` before migrations.
 *
 * The schema source of truth lives in `memory/migrations.ts`; this constant
 * only exists so corruption detection has something cheap to run (a failure
 * here triggers `quarantineDataDirectory`). Keeping it permissive
 * (`IF NOT EXISTS`, no DROPs) means a brain that has already been migrated
 * past this baseline still passes the probe untouched.
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
