import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStalePostmasterLock,
  isExternalAssetError,
  MemoryLockTimeoutError,
  openPGlite,
  openPGliteWaitingForLock,
  quarantineDataDirectory,
  releaseOpenLock,
  tryAcquireOpenLock,
} from "../src/memory/pglite.js";

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

describe("isExternalAssetError", () => {
  test("flags ENOENT on a path outside the dataDir", () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open '/x/y/pglite.data'"),
      {
        code: "ENOENT",
        path: "/x/y/pglite.data",
      },
    );
    expect(isExternalAssetError(error, "/home/user/.duet/memory.db")).toBe(true);
  });

  test("does not flag ENOENT on a path inside the dataDir", () => {
    const dataDir = "/home/user/.duet/memory.db";
    const error = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: `${dataDir}/PG_VERSION`,
    });
    expect(isExternalAssetError(error, dataDir)).toBe(false);
  });

  test("falls back to parsing the path out of the message", () => {
    const error = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open '/usr/lib/node_modules/pglite/dist/pglite.data'",
      ),
      { code: "ENOENT" },
    );
    expect(isExternalAssetError(error, "/home/user/.duet/memory.db")).toBe(true);
  });

  test("ignores non-ENOENT errors", () => {
    expect(isExternalAssetError(new Error("boom"), "/dir")).toBe(false);
  });
});

describe("openPGlite quarantine guard", () => {
  testIfDocker("does not quarantine when init fails with ENOENT on an external asset", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      const externalPath = join(tempDir, "missing-asset.data");
      let attempt = 0;
      await expect(
        openPGlite(dataDir, {
          init: async () => {
            attempt += 1;
            const error = Object.assign(
              new Error(`ENOENT: no such file or directory, open '${externalPath}'`),
              { code: "ENOENT", path: externalPath },
            );
            throw error;
          },
        }),
      ).rejects.toThrow(/ENOENT/);
      expect(attempt).toBe(1);
      expect(existsSync(dataDir)).toBe(true);
      // No quarantine sibling was created.
      const siblings = readdirSync(tempDir).filter((name) =>
        name.startsWith("memory.db.corrupted-"),
      );
      expect(siblings).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
  testIfDocker("runs the init hook on a fresh database", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      const db = await openPGlite(dataDir, {
        init: async (database) => {
          await database.exec("CREATE TABLE observations (id TEXT PRIMARY KEY)");
        },
      });

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
        init: async (database) => {
          await database.exec("CREATE TABLE observations (id TEXT PRIMARY KEY)");
        },
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

describe("openPGliteWaitingForLock", () => {
  testIfDocker("waits past a transient peer holding the open-lock", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");
      mkdirSync(dataDir, { recursive: true });

      // Simulate a peer duet process by holding the open-lock ourselves under
      // the current pid, then releasing it after a brief delay. The polling
      // open must see the lock vanish and acquire on a retry.
      const peer = tryAcquireOpenLock(dataDir);
      if (!("lockPath" in peer)) throw new Error("expected to acquire peer lock");
      const peerLockPath = peer.lockPath;
      setTimeout(() => releaseOpenLock(peerLockPath), 250);

      const db = await openPGliteWaitingForLock(
        dataDir,
        {
          init: async (database) => {
            await database.exec("CREATE TABLE observations (id TEXT PRIMARY KEY)");
          },
        },
        5_000,
      );
      const result = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM observations",
      );
      expect(result.rows[0]?.count).toBe("0");
      await db.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "throws MemoryLockTimeoutError when the budget elapses with a live holder",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
      // A live foreign pid is required to exercise the wait-then-timeout path:
      // `tryAcquireOpenLock` treats a lock file holding the current process's
      // pid as stale and steals it, so a same-process "peer" can't reproduce
      // contention here.
      const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
      const childPid = child.pid;
      if (childPid === undefined) throw new Error("spawn returned no pid");
      try {
        const dataDir = join(tempDir, "memory.db");
        mkdirSync(dataDir, { recursive: true });
        const lockPath = join(dataDir, ".duet-open.lock");
        writeFileSync(lockPath, `${childPid}\n`, "utf8");

        let caught: unknown;
        try {
          await openPGliteWaitingForLock(dataDir, {}, 150);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(MemoryLockTimeoutError);
        const err = caught as MemoryLockTimeoutError;
        expect(err.holderPid).toBe(childPid);
        expect(err.budgetMs).toBe(150);

        rmSync(lockPath, { force: true });
      } finally {
        child.kill();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
