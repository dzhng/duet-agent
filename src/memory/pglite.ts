import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";

/**
 * pgvector ships with PGlite as an opt-in WASM extension. We load it
 * unconditionally so every memory database can run hybrid retrieval
 * without a feature flag dance — the cost is one extra small WASM
 * download, paid once per install. `CREATE EXTENSION vector` then
 * succeeds inside migration v3 where the embedding tables and HNSW
 * index live.
 */
const MEMORY_EXTENSIONS = { vector } as const;

/**
 * Filename used for the cross-process open-lock written into each
 * managed data directory. The first line is the holder's pid; other
 * processes only proceed past O_EXCL if that pid is no longer alive.
 */
const OPEN_LOCK_FILE = ".duet-open.lock";

export interface OpenPGliteOptions {
  /**
   * Async hook run immediately after the database opens, in the try block
   * that triggers quarantine recovery. Typically applies schema migrations
   * so a failure rolls the directory aside instead of leaving the agent
   * wedged behind an opaque PGlite abort.
   */
  init?: (db: PGlite) => Promise<void>;
  /**
   * Called once when an unreadable data directory is quarantined and a fresh
   * one is opened in its place. Receives the path the old directory was moved
   * to so callers can surface it. When omitted, a warning is written to
   * stderr.
   */
  onRecover?: (info: { backupPath: string; cause: unknown }) => void;
}

/**
 * Thrown when the cross-process open-lock could not be acquired within
 * the caller's wait budget. `MemorySession` catches this and degrades
 * gracefully (skips the op, warns once) so a second duet CLI does not
 * crash when a long-running first CLI holds the memory db.
 */
export class MemoryLockTimeoutError extends Error {
  readonly dataDir: string;
  readonly holderPid: number;
  readonly budgetMs: number;
  constructor(dataDir: string, holderPid: number, budgetMs: number) {
    super(
      `Timed out after ${budgetMs}ms waiting for the memory db open-lock at ${dataDir} ` +
        `(held by pid ${holderPid}).`,
    );
    this.name = "MemoryLockTimeoutError";
    this.dataDir = dataDir;
    this.holderPid = holderPid;
    this.budgetMs = budgetMs;
  }
}

export type TryAcquireOpenLockResult = { lockPath: string } | { holderPid: number };

/**
 * Process-global registry of open-lock files currently held by this
 * process. Used by the exit handler to drop locks on crash so the next
 * launch (and concurrent duet CLIs) are not blocked behind a stale
 * lock pointing at a no-longer-living pid.
 */
const heldLockPaths = new Set<string>();

let exitHandlerInstalled = false;
function installExitCleanup(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const lockPath of heldLockPaths) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort on exit; nothing to do if the file is already gone.
      }
    }
  });
}

/**
 * Opens a PGlite database at `path`, recovering from three failure modes that
 * would otherwise leave the agent unable to start:
 *
 *   1. A stale `postmaster.pid` left by a crashed prior run — the lock is
 *      removed when its PID is not a live process.
 *   2. A data directory PGlite cannot read at all (corrupted, partially
 *      written, or written by an incompatible Postgres version) — detected
 *      by running the init hook as a probe. The bad directory is renamed
 *      to `<path>.corrupted-<iso-timestamp>` so the user can recover it
 *      later, and a fresh database is opened in its place.
 *   3. A cross-process open-lock so two duet CLIs cannot both call
 *      `PGlite.create` on the same fresh dataDir and corrupt each
 *      other's migrations.
 *
 * Throws synchronously-via-reject if the lock is held by a live foreign
 * process. Callers that need to wait or degrade gracefully should use
 * `MemorySession` instead, which polls `tryAcquireOpenLock`.
 */
export async function openPGlite(path: string, options: OpenPGliteOptions = {}): Promise<PGlite> {
  installExitCleanup();
  const lockPath = acquireOpenLock(path);
  try {
    const opened = await openPGliteHoldingLock(path, options, lockPath);
    return installLockReleasingClose(opened.db, opened.lockPath);
  } catch (error) {
    releaseOpenLock(lockPath);
    throw error;
  }
}

/**
 * Open the database assuming the caller already holds `lockPath` for
 * the dataDir. On a quarantine recovery the directory is renamed
 * aside, the old lockPath disappears with it, and this returns the
 * freshly-reacquired lockPath. `MemorySession` uses this so its
 * poll-acquire loop owns the lock lifecycle end-to-end.
 */
export async function openPGliteHoldingLock(
  path: string,
  options: OpenPGliteOptions,
  lockPath: string,
): Promise<{ db: PGlite; lockPath: string }> {
  installExitCleanup();
  mkdirSync(dirname(path), { recursive: true });
  clearStalePostmasterLock(path);

  try {
    const db = await openAndProbe(path, options.init);
    return { db, lockPath };
  } catch (error) {
    if (!isExistingDirectory(path)) throw error;

    // Release the lock before renaming the directory aside — the lock
    // file lives inside that directory and would be moved with it.
    releaseOpenLock(lockPath);

    const backupPath = quarantineDataDirectory(path);
    if (options.onRecover) {
      options.onRecover({ backupPath, cause: error });
    } else {
      const reason = error instanceof Error ? error.message || error.name : String(error);
      console.warn(
        `[duet] memory database at ${path} could not be opened (${reason}). ` +
          `Moved aside to ${backupPath} and starting fresh.`,
      );
    }

    const fresh = acquireOpenLock(path);
    const db = await openAndProbe(path, options.init);
    return { db, lockPath: fresh };
  }
}

/**
 * Wrap `db.close` so the cross-process lock is released alongside the
 * handle. PGlite uses private class fields internally, so a Proxy
 * around the instance breaks every method that touches one — method
 * replacement preserves identity and keeps private-field access
 * working.
 */
function installLockReleasingClose(db: PGlite, lockPath: string): PGlite {
  const originalClose = db.close.bind(db);
  let released = false;
  db.close = async () => {
    if (released) return;
    released = true;
    try {
      await originalClose();
    } finally {
      releaseOpenLock(lockPath);
    }
  };
  return db;
}

async function openAndProbe(
  path: string,
  init: ((db: PGlite) => Promise<void>) | undefined,
): Promise<PGlite> {
  // PGlite.create is the only API path that lets us register loadable
  // extensions at construction time — the bare `new PGlite(path)` form
  // skips the extension registry, leaving `CREATE EXTENSION vector` to
  // fail with "extension is not available" once migration v3 runs.
  const db = await PGlite.create({ dataDir: path, extensions: MEMORY_EXTENSIONS });
  try {
    if (init) await init(db);
    return db;
  } catch (error) {
    // The wasm module is in an aborted state on this kind of failure; closing
    // it can itself throw. Best-effort only — we just want to stop holding
    // any handle before we rename the directory out from under it.
    try {
      await db.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * Open a managed PGlite handle without running migrations or quarantining
 * on read failure. Used by the recovery tooling to read rows out of a
 * previously-quarantined `memory.db.corrupted-*` directory.
 *
 * Does not participate in the open-lock machinery; the caller owns the
 * returned instance and is responsible for `close()`.
 */
export async function openForRecovery(path: string): Promise<PGlite> {
  clearStalePostmasterLock(path);
  return PGlite.create({ dataDir: path, extensions: MEMORY_EXTENSIONS });
}

/**
 * Renames a presumed-corrupt data directory aside so a fresh database can be
 * created in its place. Returns the new path. Exported for testing.
 */
export function quarantineDataDirectory(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.corrupted-${stamp}`;
  renameSync(path, backup);
  return backup;
}

/**
 * Try once to acquire the cross-process open-lock at
 * `<dataDir>/.duet-open.lock`. Returns `{ lockPath }` on success
 * (including after a stale-pid takeover) or `{ holderPid }` when a live
 * foreign process still holds the lock. Never throws on contention so
 * callers can poll and retry without try/catch.
 */
export function tryAcquireOpenLock(dataDir: string): TryAcquireOpenLockResult {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, OPEN_LOCK_FILE);

  const created = createLockFile(lockPath);
  if (created) {
    heldLockPaths.add(created);
    return { lockPath: created };
  }

  // Lock file existed. If a live foreign process owns it, report back
  // without taking it; otherwise treat it as stale and steal it.
  const contents = tryReadFile(lockPath) ?? "";
  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const holderPid = Number.parseInt(firstLine, 10);
  if (
    Number.isFinite(holderPid) &&
    holderPid > 0 &&
    holderPid !== process.pid &&
    isProcessAlive(holderPid)
  ) {
    return { holderPid };
  }

  // Stale (crashed prior run) or our own pid from a partially-cleaned
  // failed open. Replace atomically — unlink-then-create-with-O_EXCL.
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const recreated = createLockFile(lockPath);
  if (!recreated) {
    // Another opener won the race after our stale-lock takeover. Report
    // its pid (if live) so the caller can poll again.
    const afterContents = tryReadFile(lockPath) ?? "";
    const after = Number.parseInt(afterContents.split("\n", 1)[0]?.trim() ?? "", 10);
    if (Number.isFinite(after) && after > 0 && after !== process.pid && isProcessAlive(after)) {
      return { holderPid: after };
    }
    throw new Error(
      `Failed to acquire open lock at ${lockPath}: another opener won the race after the stale-lock takeover.`,
    );
  }
  heldLockPaths.add(recreated);
  return { lockPath: recreated };
}

/**
 * Acquire the cross-process open-lock, throwing if a live foreign
 * process holds it. Used by `openPGlite` for the fast/strict path;
 * polling callers should use `tryAcquireOpenLock` instead.
 */
export function acquireOpenLock(dataDir: string): string {
  const result = tryAcquireOpenLock(dataDir);
  if ("lockPath" in result) return result.lockPath;
  throw new Error(
    `PGlite data directory ${dataDir} is locked by another duet process (pid ${result.holderPid}). ` +
      "Stop that process before opening the database.",
  );
}

/**
 * Release a lock previously returned by `tryAcquireOpenLock` /
 * `acquireOpenLock`. Idempotent and safe to call if the file has
 * already disappeared.
 */
export function releaseOpenLock(lockPath: string): void {
  heldLockPaths.delete(lockPath);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createLockFile(lockPath: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return lockPath;
}

/**
 * If `dataDir` contains a `postmaster.pid` whose PID is not a live process,
 * remove the lock so PGlite can start. If the PID is alive, throw with a clear
 * message rather than letting PGlite abort opaquely. Exported for testing.
 */
export function clearStalePostmasterLock(dataDir: string): void {
  if (!isExistingDirectory(dataDir)) return;

  const lockPath = join(dataDir, "postmaster.pid");
  const contents = tryReadFile(lockPath);
  if (contents === undefined) return;

  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const pid = Number.parseInt(firstLine, 10);

  if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(
      `PGlite data directory ${dataDir} is locked by an active process (pid ${pid}). ` +
        "Stop that process before opening the database.",
    );
  }

  unlinkSync(lockPath);
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Internal: lets tests reach into the held-lock registry to assert
// exit cleanup behavior without exporting it on the public surface.
export const __testing = {
  heldLockPaths,
  resolvePath,
};
