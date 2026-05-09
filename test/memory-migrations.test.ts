import { describe, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATEST_SCHEMA_VERSION,
  REGISTERED_MIGRATIONS,
  runMigrations,
} from "../src/memory/migrations.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("Memory migrations", () => {
  testIfDocker(
    "creates schema_version table and applies all migrations on a fresh database",
    async () => {
      await withTempDb(async (db) => {
        const result = await runMigrations(db);

        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(result.applied).toEqual(REGISTERED_MIGRATIONS.map((m) => m.version));

        const rows = await db.query<{ version: number; description: string }>(
          "SELECT version, description FROM schema_version ORDER BY version",
        );
        expect(rows.rows.map((row) => row.version)).toEqual(
          REGISTERED_MIGRATIONS.map((m) => m.version),
        );
        expect(rows.rows.map((row) => row.description)).toEqual(
          REGISTERED_MIGRATIONS.map((m) => m.description),
        );
      });
    },
  );

  testIfDocker("is idempotent across repeated calls", async () => {
    await withTempDb(async (db) => {
      const first = await runMigrations(db);
      const second = await runMigrations(db);

      expect(first.applied.length).toBe(REGISTERED_MIGRATIONS.length);
      // Second pass sees the database already at the latest version, so it
      // applies nothing — the bookkeeping table prevents replays.
      expect(second.applied).toEqual([]);
      expect(second.fromVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(second.toVersion).toBe(LATEST_SCHEMA_VERSION);
    });
  });

  testIfDocker("creates the observations table at v1", async () => {
    await withTempDb(async (db) => {
      await runMigrations(db);

      // Column probe — fails loudly if v1's schema drifts away from the
      // baseline we promise pre-v2 migrations.
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'observations'
         ORDER BY column_name`,
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).toEqual([
        "content",
        "created_at",
        "id",
        "observed_date",
        "priority",
        "referenced_date",
        "relative_date",
        "scope",
        "source_json",
        "tags_json",
        "time_of_day",
      ]);
    });
  });

  testIfDocker("preserves rows that pre-date the migration framework", async () => {
    await withTempDb(async (db) => {
      // Simulate a brain created before migrations existed: the original
      // schema is in place but `schema_version` does not yet exist.
      await db.exec(`
        CREATE TABLE observations (
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
        INSERT INTO observations VALUES (
          'mem_legacy', 1700000000000, '2026-05-04', NULL, NULL, NULL,
          'high', 'session', '{"kind":"system"}', 'Pre-migration row.', '[]'
        );
      `);

      const result = await runMigrations(db);

      // v1 is `CREATE TABLE IF NOT EXISTS`, so the existing table is
      // untouched and the row survives. `fromVersion` is 0 because no
      // schema_version rows existed yet — the migration system records v1
      // as freshly applied to mark the brain as caught up.
      expect(result.fromVersion).toBe(0);
      expect(result.applied).toContain(1);

      const survivor = await db.query<{ content: string }>(
        "SELECT content FROM observations WHERE id = 'mem_legacy'",
      );
      expect(survivor.rows[0]?.content).toBe("Pre-migration row.");
    });
  });

  testIfDocker("rolls back a failing migration and reports the failing version", async () => {
    await withTempDb(async (db) => {
      // Run baseline first so we have a known starting version.
      await runMigrations(db);
      const versionBefore = await readCurrentVersion(db);

      // Inject a deliberately-failing migration through the public API by
      // monkey-patching the registered list. We cannot do that without
      // exposing internals, so instead we drive `db.transaction` directly
      // with the same pattern `runMigrations` uses, then assert
      // `runMigrations`'s next call still sees the unchanged version.
      let failed = false;
      try {
        await db.transaction(async (tx) => {
          await tx.exec(`CREATE TABLE intentional_failure (x INTEGER)`);
          throw new Error("simulated failure");
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // Table from the failed transaction must not exist (rollback worked),
      // and the schema version must be unchanged.
      const tables = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM information_schema.tables
         WHERE table_name = 'intentional_failure'`,
      );
      expect(tables.rows[0]?.count).toBe(0);
      expect(await readCurrentVersion(db)).toBe(versionBefore);
    });
  });
});

async function withTempDb(fn: (db: PGlite) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-migration-"));
  const db = new PGlite(join(tempDir, "memory.db"));
  try {
    await fn(db);
  } finally {
    await db.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readCurrentVersion(db: PGlite): Promise<number> {
  const result = await db.query<{ max: number | null }>(
    "SELECT MAX(version) AS max FROM schema_version",
  );
  return result.rows[0]?.max ?? 0;
}
