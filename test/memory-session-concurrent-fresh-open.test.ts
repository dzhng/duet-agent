import { describe, expect } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openForRecovery } from "../src/memory/pglite.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Regression guard for the original migration-race bug (commit 5a61105):
 * two concurrent opens on a fresh dataDir both passed the stale-lock
 * check, both called `PGlite.create`, and both ran migrations, corrupting
 * the directory so the next open had to quarantine it.
 *
 * Under the new `MemorySession` design the cross-process lock is held
 * only while a `withDb` call is in flight (plus the 2s idle close window),
 * which enables a second duet CLI to wait its turn. The migration-race
 * guarantee now rests entirely on the `O_EXCL` `.duet-open.lock` file
 * being honored by truly separate processes. This test pins that
 * property by spawning N child processes (different pids) that all
 * fight for a fresh dataDir at once and asserting exactly one migration
 * ran and no quarantine fired.
 */
describe("MemorySession concurrent fresh open", () => {
  testIfDocker(
    "many parallel processes opening a fresh dataDir run migrations exactly once",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-fresh-open-"));
      try {
        const dataDir = join(tempDir, "memory.db");
        const concurrency = 8;
        const scriptPath = join(tempDir, "open-worker.mjs");
        writeFileSync(scriptPath, workerScript(process.cwd()), "utf8");

        const results = await Promise.all(
          Array.from({ length: concurrency }, () => spawnWorker(scriptPath, dataDir)),
        );

        // Every worker reached withDb successfully and got a row from
        // the SELECT 1 query. A skipped op or a thrown error would
        // mean lock acquisition fell over.
        for (const result of results) {
          expect(result.error).toBeUndefined();
          expect(result.rows).toBe(1);
        }

        // No quarantine sibling means none of the workers corrupted
        // the dataDir mid-migration.
        const parent = dirname(dataDir);
        const siblings = readdirSync(parent).filter((name) =>
          name.startsWith("memory.db.corrupted-"),
        );
        expect(siblings).toEqual([]);

        // Migrations ran exactly once. `schema_version` carries one row
        // per applied migration; if two workers had both raced through
        // `runMigrations`, we would see duplicates here.
        const recovery = await openForRecovery(dataDir);
        try {
          const versions = await recovery.query<{ version: number }>(
            "SELECT version FROM schema_version ORDER BY version ASC",
          );
          const versionCounts = new Map<number, number>();
          for (const row of versions.rows) {
            versionCounts.set(row.version, (versionCounts.get(row.version) ?? 0) + 1);
          }
          for (const [, count] of versionCounts) {
            expect(count).toBe(1);
          }
          // Sanity: at least the v1 migration landed, otherwise the
          // assertion above passes trivially against an empty table.
          expect(versions.rows.length).toBeGreaterThan(0);
        } finally {
          await recovery.close();
        }

        // Lock file is released once every session has finished idle-closing.
        expect(existsSync(join(dataDir, ".duet-open.lock"))).toBe(false);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

interface WorkerResult {
  rows: number;
  error?: string;
}

async function spawnWorker(scriptPath: string, dataDir: string): Promise<WorkerResult> {
  const proc = Bun.spawn(["bun", scriptPath, dataDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  try {
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as WorkerResult;
  } catch {
    return { rows: 0, error: `worker produced no JSON; stderr=${stderr}` };
  }
}

function workerScript(cwd: string): string {
  // The worker runs as a one-shot bun script. It imports the session
  // module from the repo under test, opens, runs SELECT 1, disposes,
  // and prints a single JSON line to stdout for the parent to parse.
  return `
import { MemorySession } from "${cwd}/src/memory/session.ts";
import { runMigrations } from "${cwd}/src/memory/migrations.ts";

const dataDir = process.argv[2];
const session = new MemorySession({
  path: dataDir,
  openOptions: { init: async (db) => { await runMigrations(db); } },
});
try {
  const result = await session.withDb(async (db) => db.query("SELECT 1 AS ok"));
  process.stdout.write(JSON.stringify({ rows: result?.rows.length ?? 0 }) + "\\n");
} catch (error) {
  process.stdout.write(
    JSON.stringify({ rows: 0, error: error instanceof Error ? error.message : String(error) }) + "\\n",
  );
} finally {
  await session.dispose();
}
`;
}
