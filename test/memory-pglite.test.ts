import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStalePostmasterLock,
  isExternalAssetError,
  listBackups,
  looksLikeIntactPGliteDirectory,
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

describe("looksLikeIntactPGliteDirectory", () => {
  test("returns false for a missing directory", () => {
    expect(looksLikeIntactPGliteDirectory("/definitely/not/a/real/path")).toBe(false);
  });

  testIfDocker("returns false when PG_VERSION is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      mkdirSync(join(dataDir, "base"));
      mkdirSync(join(dataDir, "global"));
      mkdirSync(join(dataDir, "pg_wal"));
      expect(looksLikeIntactPGliteDirectory(dataDir)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("returns false when a required cluster subdir is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      writeFileSync(join(dataDir, "PG_VERSION"), "16\n", "utf8");
      mkdirSync(join(dataDir, "base"));
      mkdirSync(join(dataDir, "global"));
      // pg_wal intentionally omitted
      expect(looksLikeIntactPGliteDirectory(dataDir)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  testIfDocker("returns true when PG_VERSION and all required subdirs are present", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      writeFileSync(join(dataDir, "PG_VERSION"), "16\n", "utf8");
      mkdirSync(join(dataDir, "base"));
      mkdirSync(join(dataDir, "global"));
      mkdirSync(join(dataDir, "pg_wal"));
      expect(looksLikeIntactPGliteDirectory(dataDir)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("openPGlite quarantine guard", () => {
  // Repro for the `duet upgrade while another duet is running` corruption:
  // npm rewrites node_modules, the still-running duet reopens its memory db,
  // PGlite hits a half-written wasm/data file and throws a WebAssembly /
  // RangeError that is NOT strictly ENOENT. Before the structural guard,
  // any such throw quarantined a perfectly intact memory.db. With the
  // guard, an intact cluster on disk is left alone and the error surfaces.
  // Helper: seed `dataDir` with a real, cleanly-closed PGlite cluster so
  // subsequent opens exercise the retry / quarantine paths against actual
  // PGlite layout, not a hand-rolled stub that fails `PGlite.create`
  // before our init callback ever runs.
  async function seedRealCluster(dataDir: string): Promise<void> {
    const db = await openPGlite(dataDir);
    await db.close();
  }

  testIfDocker(
    "transient init failure on an intact cluster recovers via retry without quarantine",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
      try {
        const dataDir = join(tempDir, "memory.db");
        await seedRealCluster(dataDir);

        // First call fails as if a `npm install -g` was halfway through
        // rewriting `node_modules`; second call succeeds the way it would
        // once npm finishes. The retry path should ride out the transient
        // and quarantine should never run.
        let attempt = 0;
        const db = await openPGlite(dataDir, {
          init: async () => {
            attempt += 1;
            if (attempt === 1) {
              throw new WebAssembly.CompileError("wasm validation failed");
            }
          },
        });
        try {
          expect(attempt).toBe(2);
          const siblings = readdirSync(tempDir).filter((name) =>
            name.startsWith("memory.db.corrupted-"),
          );
          expect(siblings).toEqual([]);
        } finally {
          await db.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  // Inverse case: real WAL corruption from a kill mid-write leaves the
  // cluster structurally intact but fails deterministically on every open.
  // The retry must NOT mask this — after the second failure we quarantine
  // so the user gets a fresh db instead of being wedged forever.
  testIfDocker(
    "deterministic init failure on an intact cluster still quarantines after retry",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
      try {
        const dataDir = join(tempDir, "memory.db");
        await seedRealCluster(dataDir);

        let attempt = 0;
        let quarantineRan = false;
        let recoveredBackupPath: string | undefined;
        const db = await openPGlite(dataDir, {
          init: async () => {
            attempt += 1;
            // Fail every attempt against the original dataDir; only stop
            // throwing once the dir has been quarantined and the caller
            // is opening a fresh cluster. We detect that by checking
            // whether the corrupted-* sibling already exists when init
            // runs — the rename happens before the post-quarantine open.
            const siblings = readdirSync(tempDir).filter((name) =>
              name.startsWith("memory.db.corrupted-"),
            );
            if (siblings.length === 0) {
              // Shape of a WAL-corruption error: deterministic, not ENOENT.
              throw new Error("invalid magic number 0000 in log segment");
            }
            quarantineRan = true;
          },
          onRecover: ({ backupPath }) => {
            recoveredBackupPath = backupPath;
          },
        });
        try {
          expect(quarantineRan).toBe(true);
          expect(attempt).toBeGreaterThanOrEqual(3);
          expect(recoveredBackupPath).toBeDefined();
          const siblings = readdirSync(tempDir).filter((name) =>
            name.startsWith("memory.db.corrupted-"),
          );
          expect(siblings).toHaveLength(1);
        } finally {
          await db.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

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

describe("startup backup snapshots", () => {
  // Push every existing backup's mtime far enough into the past that the
  // dedupe window stops suppressing the next snapshot. Real usage spans days
  // between sessions so the window is harmless; tests run in milliseconds
  // and would otherwise see only the very first snapshot ever taken.
  function ageAllBackups(dataDir: string): void {
    const ancient = new Date("2026-01-01T00:00:00Z");
    for (const backup of listBackups(dataDir)) {
      utimesSync(backup, ancient, ancient);
    }
  }

  testIfDocker("snapshots on a successful open and dedupes within the window", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");

      // Fresh open of an empty dataDir snapshots the just-validated cluster.
      const a = await openPGlite(dataDir);
      await a.close();
      const afterFirst = listBackups(dataDir);
      expect(afterFirst).toHaveLength(1);

      // Reopen inside the dedupe window must not add a second backup so
      // MemorySession refcount-opens don't burn inodes on every acquire.
      const b = await openPGlite(dataDir);
      await b.close();
      expect(listBackups(dataDir)).toEqual(afterFirst);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "only snapshots after a successful open + init",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
      try {
        const dataDir = join(tempDir, "memory.db");

        // Seed a healthy cluster (one snapshot taken), then age it so the
        // dedupe window does not mask the test — a second snapshot would be
        // free to take if the success path ran.
        const seed = await openPGlite(dataDir);
        await seed.close();
        expect(listBackups(dataDir)).toHaveLength(1);
        ageAllBackups(dataDir);

        // An open that fails the initial probe must NOT snapshot — entries
        // in the backup pool must be verified-readable. The recovery path
        // restores from the existing aged snapshot and we verify that the
        // pool size did not grow with a (potentially corrupt) new entry.
        const recovered = await openPGlite(dataDir, {
          init: async () => {
            // Throw against the live dir; once recovery moves it aside the
            // restored backup has no `corrupted-` sibling yet, so we let
            // that open through.
            const stillLive = readdirSync(tempDir).some((name) =>
              name.startsWith("memory.db.corrupted-"),
            );
            if (!stillLive) throw new Error("WAL torn");
          },
        });
        await recovered.close();

        // No new backups were taken — the only snapshot is still the aged
        // seed (it was consumed by the restore, so the pool is now empty;
        // we just want to confirm the failed open did NOT add an entry).
        const after = listBackups(dataDir);
        expect(after.length).toBeLessThanOrEqual(1);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  testIfDocker("prunes to the five newest backups", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
    try {
      const dataDir = join(tempDir, "memory.db");

      // Plant six pre-existing backups, all aged past the dedupe window
      // so the next real snapshot is free to take. The new snapshot
      // becomes the seventh entry and pruning should leave exactly
      // MAX_BACKUPS (5) on disk — the two oldest pre-planted dirs go.
      const ancient = new Date("2026-01-01T00:00:00Z");
      for (let i = 0; i < 6; i++) {
        const stamp = `2026-01-0${i + 1}T00-00-00-000Z`;
        const dir = `${dataDir}.backup-${stamp}`;
        mkdirSync(dir);
        writeFileSync(join(dir, "marker"), String(i), "utf8");
        utimesSync(dir, ancient, ancient);
      }

      const db = await openPGlite(dataDir);
      await db.close();

      const remaining = listBackups(dataDir);
      expect(remaining).toHaveLength(5);
      // Newest-first — the just-taken snapshot leads the list and is
      // distinguishable from the planted 2026-01-0X stamps.
      const newest = remaining[0]!;
      expect(newest.startsWith(`${dataDir}.backup-`)).toBe(true);
      expect(newest).not.toMatch(/2026-01-0[0-9]T/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // End-to-end corruption-recovery: a deterministic init failure on a
  // structurally intact cluster used to quarantine and start from an empty db.
  // Now, if a previous startup left a usable backup, we restore from it
  // instead so the user keeps their memory.
  testIfDocker(
    "restores from the newest backup and recovers the data the live dir lost",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-pglite-"));
      try {
        const dataDir = join(tempDir, "memory.db");

        // Session 1: open (initial empty snapshot taken), write a marker,
        // close. The marker is now on disk in the live dir but NOT yet
        // captured in any backup.
        {
          const db = await openPGlite(dataDir);
          await db.exec("CREATE TABLE marker (v TEXT)");
          await db.exec("INSERT INTO marker (v) VALUES ('from-backup')");
          await db.close();
        }
        ageAllBackups(dataDir);

        // Session 2: reopen, take a snapshot of the now-populated cluster,
        // close. This is the snapshot the recovery path should restore.
        {
          const db = await openPGlite(dataDir);
          await db.close();
        }
        expect(listBackups(dataDir)).toHaveLength(2);

        // Session 3: simulate corruption (deterministic init failure).
        // After the retry budget elapses, recovery walks backups newest-
        // first, restores the populated snapshot, and verifies it by
        // opening it cleanly (our trigger only throws against the
        // original live dir).
        let recoveredQuarantinePath: string | undefined;
        const db = await openPGlite(dataDir, {
          init: async () => {
            const stillLive = readdirSync(tempDir).some((name) =>
              name.startsWith("memory.db.corrupted-"),
            );
            if (!stillLive) {
              throw new Error("invalid magic number 0000 in log segment");
            }
          },
          onRecover: ({ backupPath }) => {
            recoveredQuarantinePath = backupPath;
          },
        });
        try {
          const row = await db.query<{ v: string }>("SELECT v FROM marker");
          expect(row.rows).toEqual([{ v: "from-backup" }]);
          expect(recoveredQuarantinePath).toBeDefined();
          expect(recoveredQuarantinePath!.startsWith(`${dataDir}.corrupted-`)).toBe(true);
          // Quarantine sibling now exists alongside; the consumed backup
          // is no longer in the pool.
          const siblings = readdirSync(tempDir);
          expect(siblings.filter((name) => name.startsWith("memory.db.corrupted-"))).toHaveLength(
            1,
          );
        } finally {
          await db.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
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
