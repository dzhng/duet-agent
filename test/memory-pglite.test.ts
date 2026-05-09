import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStalePostmasterLock,
  openPGlite,
  quarantineDataDirectory,
} from "../src/memory/pglite.js";
import { OBSERVATIONS_SCHEMA_SQL } from "../src/memory/schema.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("clearStalePostmasterLock", () => {
  testIfDocker("does nothing when the data directory does not exist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "missing");
      expect(() => clearStalePostmasterLock(dataDir)).not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker("does nothing when no lock file is present", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      expect(() => clearStalePostmasterLock(dataDir)).not.toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("removes a lock file with an invalid (negative) PID", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const lockPath = join(dataDir, "postmaster.pid");
      writeFileSync(lockPath, "-42\n/pglite/data\n1778337409\n5432\n", "utf8");

      clearStalePostmasterLock(dataDir);

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("removes a lock file whose PID is not running", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const lockPath = join(dataDir, "postmaster.pid");
      // PID 2^31 - 1 is the max — vanishingly unlikely to be in use.
      writeFileSync(lockPath, "2147483647\n/pglite/data\n", "utf8");

      clearStalePostmasterLock(dataDir);

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("removes a lock file whose first line is unparseable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const lockPath = join(dataDir, "postmaster.pid");
      writeFileSync(lockPath, "garbage\n", "utf8");

      clearStalePostmasterLock(dataDir);

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("throws a clear error when the lock's PID is the current live process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const lockPath = join(dataDir, "postmaster.pid");
      writeFileSync(lockPath, `${process.pid}\n/pglite/data\n`, "utf8");

      expect(() => clearStalePostmasterLock(dataDir)).toThrow(/locked by an active process/);
      // Lock should still be present — we don't remove it when active.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("ignores nested directories named postmaster.pid", async () => {
    // Defensive: if something odd put a directory at that path, statSync would
    // succeed but readFileSync would throw EISDIR. We want a real error here,
    // not a silent unlink attempt — so this surfaces as an unhandled throw.
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      mkdirSync(join(dataDir, "postmaster.pid"));
      expect(() => clearStalePostmasterLock(dataDir)).toThrow();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("quarantineDataDirectory", () => {
  testIfDocker("renames the directory aside with an iso-timestamp suffix", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, "marker"), "hello", "utf8");

      const backup = quarantineDataDirectory(dataDir);

      expect(backup.startsWith(`${dataDir}.corrupted-`)).toBe(true);
      expect(existsSync(dataDir)).toBe(false);
      expect(existsSync(join(backup, "marker"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("openPGlite", () => {
  testIfDocker("opens a fresh database and applies the schema probe", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      const db = await openPGlite(dataDir, { schemaSql: OBSERVATIONS_SCHEMA_SQL });

      const result = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM observations",
      );
      expect(result.rows[0]?.count).toBe("0");

      await db.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker("quarantines an unreadable data directory and starts fresh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      // PGlite refuses to start when the data directory is non-empty but
      // missing the structure it expects (no PG_VERSION, no global/, etc.).
      // This mimics the real-world corruption case.
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, "stray"), "garbage", "utf8");
      writeFileSync(join(dataDir, "PG_VERSION"), "999\n", "utf8");

      let recoveredFrom: string | undefined;
      const db = await openPGlite(dataDir, {
        schemaSql: OBSERVATIONS_SCHEMA_SQL,
        onRecover: ({ backupPath }) => {
          recoveredFrom = backupPath;
        },
      });

      expect(recoveredFrom).toBeDefined();
      expect(recoveredFrom?.startsWith(`${dataDir}.corrupted-`)).toBe(true);
      // The fresh database is usable.
      const result = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM observations",
      );
      expect(result.rows[0]?.count).toBe("0");
      await db.close();

      // Corrupted contents are preserved under the backup path.
      const backupContents = readdirSync(recoveredFrom as string);
      expect(backupContents).toContain("stray");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
