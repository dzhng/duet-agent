import { describe, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { MemorySession } from "../src/memory/session.js";
import { runMigrations } from "../src/memory/migrations.js";
import { testIfDocker } from "./helpers/docker-only.js";

async function migrate(db: PGlite): Promise<void> {
  await runMigrations(db);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MemorySession", () => {
  testIfDocker("idle close: handle stays open within window, second withDb reuses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-session-idle-"));
    const dataDir = join(dir, "memory.db");
    const session = new MemorySession({
      path: dataDir,
      openOptions: { init: migrate },
      idleCloseMs: 800,
    });
    try {
      const lockPath = join(dataDir, ".duet-open.lock");

      const first = await session.withDb(async (db) => {
        const result = await db.query<{ v: number }>(`SELECT 1 AS v`);
        return result.rows[0]?.v;
      });
      expect(first).toBe(1);

      // Within the idle window the lock file must still exist.
      await sleep(200);
      expect(existsSync(lockPath)).toBe(true);

      // Second withDb within window reuses the open handle (no new
      // PGlite.create). We verify reuse indirectly: the call returns
      // fast (< the idle window) and the lock never went away in
      // between.
      const reuseStart = Date.now();
      const second = await session.withDb(async (db) => {
        const result = await db.query<{ v: number }>(`SELECT 2 AS v`);
        return result.rows[0]?.v;
      });
      const reuseMs = Date.now() - reuseStart;
      expect(second).toBe(2);
      // A reopen would take hundreds of ms (PGlite.create + migrations).
      // A reuse completes in well under that.
      expect(reuseMs).toBeLessThan(200);

      // After idle, the handle closes and the lock is released.
      await sleep(1500);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("multi-second op holds the lock for its full duration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-session-long-"));
    const dataDir = join(dir, "memory.db");
    const lockPath = join(dataDir, ".duet-open.lock");
    const session = new MemorySession({
      path: dataDir,
      openOptions: { init: migrate },
      idleCloseMs: 800,
    });
    try {
      const startedAt = Date.now();
      const pending = session.withDb(async () => {
        await sleep(2_500);
        return "done";
      });

      // Lock must stay held throughout the in-flight op.
      await sleep(1_500);
      expect(existsSync(lockPath)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2_500);

      const result = await pending;
      expect(result).toBe("done");

      // Idle timer only starts after the op resolves. The lock is
      // still held immediately after resolution and only released
      // ~idleCloseMs later.
      expect(existsSync(lockPath)).toBe(true);
      await sleep(1_400);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("burst: concurrent withDb calls share a single open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-session-burst-"));
    const dataDir = join(dir, "memory.db");
    let initCalls = 0;
    const session = new MemorySession({
      path: dataDir,
      openOptions: {
        init: async (db) => {
          initCalls++;
          await migrate(db);
        },
      },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          session.withDb(async (db) => {
            const r = await db.query<{ v: number }>(`SELECT ${i} AS v`);
            return r.rows[0]?.v;
          }),
        ),
      );
      expect(results).toEqual([0, 1, 2, 3, 4]);
      // Exactly one PGlite.create + init across all 5 concurrent calls.
      expect(initCalls).toBe(1);
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("exhausted lock budget resolves to undefined and warns exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-session-busy-"));
    const dataDir = join(dir, "memory.db");

    // Plant a foreign live-pid lock by writing a long-lived child
    // process's pid into the lockfile. The session's poll loop
    // re-checks liveness each tick, so the child must outlive the
    // budget.
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dataDir, { recursive: true });
      await writeFile(join(dataDir, ".duet-open.lock"), `${child.pid}\n`);

      const warnings: string[] = [];
      const session = new MemorySession({
        path: dataDir,
        openOptions: { init: migrate },
        lockWaitBudgetMs: 400,
        onWarn: (m) => warnings.push(m),
      });
      try {
        const started = Date.now();
        const result = await session.withDb(async () => "should-not-run");
        const elapsed = Date.now() - started;
        expect(result).toBeUndefined();
        // Spent close to the budget but not absurdly more.
        expect(elapsed).toBeGreaterThanOrEqual(350);
        expect(elapsed).toBeLessThan(2_000);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("memory db busy");
      } finally {
        await session.dispose();
      }
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("dispose waits for an in-flight withDb to settle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-session-dispose-"));
    const dataDir = join(dir, "memory.db");
    const lockPath = join(dataDir, ".duet-open.lock");
    const session = new MemorySession({
      path: dataDir,
      openOptions: { init: migrate },
      idleCloseMs: 5_000,
    });

    let opResolved = false;
    const pending = session.withDb(async () => {
      await sleep(700);
      opResolved = true;
      return "ok";
    });

    // Give the open a moment to acquire the lock.
    await sleep(100);
    expect(existsSync(lockPath)).toBe(true);

    const disposeStart = Date.now();
    const disposed = session.dispose();

    // dispose must not return before the in-flight op resolves.
    await disposed;
    const disposeMs = Date.now() - disposeStart;
    expect(opResolved).toBe(true);
    expect(await pending).toBe("ok");
    expect(disposeMs).toBeGreaterThanOrEqual(500);

    // Lock released after dispose despite the long idleCloseMs.
    expect(existsSync(lockPath)).toBe(false);

    // Post-dispose, withDb is a no-op.
    const after = await session.withDb(async () => "should-not-run");
    expect(after).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});
