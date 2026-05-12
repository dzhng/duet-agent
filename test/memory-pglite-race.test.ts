import { describe, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openPGlite } from "../src/memory/pglite.js";
import type { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/memory/migrations.js";
import { testIfDocker } from "./helpers/docker-only.js";

async function migrate(db: PGlite): Promise<void> {
  await runMigrations(db);
}

describe("openPGlite concurrent-open race", () => {
  // Scenario 4 from the corruption repro: two opens fire at the same
  // fresh dataDir. Pre-fix, both raced into `PGlite.create` and double-
  // ran migrations, corrupting the dir so the next open had to be
  // quarantined. Post-fix, in-process callers share one handle and one
  // cross-process lock; reopening after dispose must succeed without
  // any `.corrupted-*` siblings appearing.
  testIfDocker("two parallel openPGlite calls share a handle and survive reopen", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-race-"));
    try {
      const dataDir = join(tempDir, "memory.db");

      const [first, second] = await Promise.all([
        openPGlite(dataDir, { init: migrate }),
        openPGlite(dataDir, { init: migrate }),
      ]);

      // Both calls observe the same underlying database — a write via
      // one wrapper is visible through the other immediately.
      await first.query(
        `INSERT INTO observations (
           id, created_at, last_used_at, kind, observed_date, priority, source_json, content, tags_json
         ) VALUES ('mem_race', 1, 1, 'observation', '2026-05-12', 'low',
                   '{"kind":"system"}', 'race-marker', '[]')`,
      );
      const seen = await second.query<{ content: string }>(
        `SELECT content FROM observations WHERE id = 'mem_race'`,
      );
      expect(seen.rows[0]?.content).toBe("race-marker");

      // Close in the order callers would: each wrapper releases its
      // refcount, the underlying handle and lock teardown on the last.
      await first.close();
      await second.close();

      // Reopen — the dir must be readable, not quarantined.
      const reopened = await openPGlite(dataDir, { init: migrate });
      const survived = await reopened.query<{ content: string }>(
        `SELECT content FROM observations WHERE id = 'mem_race'`,
      );
      expect(survived.rows[0]?.content).toBe("race-marker");
      await reopened.close();

      // Crucial: no quarantined sibling means the race did not corrupt.
      const parent = dirname(dataDir);
      const siblings = readdirSync(parent).filter((name) =>
        name.startsWith("memory.db.corrupted-"),
      );
      expect(siblings).toEqual([]);

      // Lock file is released on the last close.
      expect(existsSync(join(dataDir, ".duet-open.lock"))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker("rejects a second open when a live foreign pid holds the lock", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-foreign-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      mkdirSync(dataDir, { recursive: true });
      // Plant a lock file owned by pid 1 (init), which is always
      // alive in the docker test container and is not our own pid —
      // matches the shape of another duet CLI sitting on the dir.
      writeFileSync(join(dataDir, ".duet-open.lock"), `1\n`);

      await expect(openPGlite(dataDir, { init: migrate })).rejects.toThrow(
        /locked by another duet process/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
