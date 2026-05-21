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
 * Default wall-time budget used by `openPGliteWaitingForLock` and the `duet memory` CLI when
 * polling for the cross-process open-lock. Long enough to outlast a moderate burst of writes
 * from a concurrent duet process but bounded so a wedged peer cannot stall the caller
 * indefinitely.
 */
export const DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS = 30_000;

/**
 * Total wall-time we'll spend retrying opens on a structurally-intact cluster before
 * giving up and quarantining. Long enough to outlast a slow `npm install -g` rewrite
 * of `node_modules` (the only known transient failure mode that mimics corruption,
 * routinely 5-12s on cold caches), short enough that a genuinely WAL-corrupted
 * dataDir still quarantines within a tolerable startup window.
 */
const RETRY_BEFORE_QUARANTINE_BUDGET_MS = 15_000;

/**
 * Backoff schedule between retry attempts during the quarantine grace window.
 * Front-loaded (250ms, 500ms, 1s) so a fast upgrade is picked up quickly,
 * with a 2s ceiling so a long `npm install` does not produce a retry storm
 * before the budget elapses.
 */
const RETRY_BACKOFF_MS = [250, 500, 1_000, 2_000];

/**
 * Exponential backoff schedule used by `pollAcquireOpenLock`. Doubles from 50ms up to a 1s
 * ceiling so a peer that releases the lock during an idle-close gap is picked up within ~50ms,
 * while a long-running peer does not produce a poll storm.
 */
const POLL_BACKOFF_MS = [50, 100, 200, 400, 800, 1000];

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
 * Like `openPGlite` but polls `tryAcquireOpenLock` up to `waitBudgetMs` (default
 * `DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS`) before giving up, so a short-lived CLI does not crash
 * when a peer duet process is briefly holding the open-lock. Used by the `duet memory`
 * subcommand; the runner's hot path uses `MemorySession` instead so it can refcount opens
 * across many ops. On budget exhaustion throws `MemoryLockTimeoutError` carrying the most
 * recently observed holder pid so callers can render a useful message.
 */
export async function openPGliteWaitingForLock(
  path: string,
  options: OpenPGliteOptions = {},
  waitBudgetMs: number = DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS,
): Promise<PGlite> {
  installExitCleanup();
  const lockPath = await pollAcquireOpenLock(path, waitBudgetMs);
  try {
    const opened = await openPGliteHoldingLock(path, options, lockPath);
    return installLockReleasingClose(opened.db, opened.lockPath);
  } catch (error) {
    releaseOpenLock(lockPath);
    throw error;
  }
}

/**
 * Poll `tryAcquireOpenLock` with exponential backoff until either the lock is acquired or
 * `budgetMs` has elapsed. Shared by `MemorySession` (per-op acquire) and the `duet memory`
 * CLI (single acquire for the lifetime of the TUI). Throws `MemoryLockTimeoutError` with the
 * most recently observed holder pid on exhaustion.
 */
export async function pollAcquireOpenLock(dataDir: string, budgetMs: number): Promise<string> {
  const start = Date.now();
  let attempt = 0;
  let lastHolderPid = 0;
  while (true) {
    const result = tryAcquireOpenLock(dataDir);
    if ("lockPath" in result) return result.lockPath;
    // Preserve the last *known* holder pid across retries: the
    // stale-takeover subpath can momentarily report 0 when the file
    // content is unparseable or the racer has already exited. We
    // don't want that to clobber a real pid we observed earlier and
    // surface "held by pid 0" in the eventual timeout error.
    if (result.holderPid > 0) lastHolderPid = result.holderPid;
    const elapsed = Date.now() - start;
    if (elapsed >= budgetMs) {
      throw new MemoryLockTimeoutError(dataDir, lastHolderPid, budgetMs);
    }
    const base = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)] ?? 1000;
    const remaining = budgetMs - elapsed;
    const delay = Math.max(1, Math.min(base, remaining));
    attempt++;
    await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Do not quarantine when the failure is about something outside the
    // user's dataDir — typically a PGlite runtime asset missing from
    // node_modules during a self-update (e.g. ENOENT on `pglite.data`).
    // Renaming the perfectly healthy memory.db aside in that window has
    // burned real users; let the error surface so the next launch (with
    // node_modules fully unpacked) succeeds against the existing data.
    if (isExternalAssetError(error, path)) throw error;
    // Retry-then-quarantine for the structurally-intact case. A `duet
    // upgrade` running concurrently with another duet CLI rewrites
    // node_modules mid-flight, and the still-running duet's reopen can
    // surface failure shapes that are not strictly ENOENT (a half-written
    // wasm/data file appears as a `WebAssembly.CompileError`, a
    // `RangeError`, or an ENOENT without a parseable path). These all
    // resolve on their own once npm finishes, so polling for a tolerant
    // window distinguishes them from genuine data corruption (WAL torn by
    // a kill mid-write), which fails deterministically on every attempt.
    // We only run the retry loop when the on-disk cluster *looks* intact
    // (PG_VERSION + required subdirs present) so a clearly broken layout
    // still quarantines immediately on the first failure.
    if (looksLikeIntactPGliteDirectory(path)) {
      const opened = await retryOpenWhileIntact(path, options.init);
      if (opened) return { db: opened, lockPath };
      // Every attempt within the grace window failed — treat as genuine
      // corruption and fall through to quarantine using the original
      // error as the recovery cause.
    }

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

/**
 * Poll `openAndProbe` for up to `RETRY_BEFORE_QUARANTINE_BUDGET_MS` while the on-disk
 * cluster keeps looking intact. Returns the opened db on success, or `undefined` when
 * the budget elapses (the caller then quarantines). External-asset ENOENTs short-circuit
 * the loop — they signal a node_modules-side problem the retry cannot fix, and surfacing
 * them as-is lets the user act on the real failure instead of waiting 15s to no effect.
 * If the directory layout becomes structurally broken during the loop (e.g. a peer
 * process truncated it), we also bail so quarantine can run.
 */
async function retryOpenWhileIntact(
  path: string,
  init: ((db: PGlite) => Promise<void>) | undefined,
): Promise<PGlite | undefined> {
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    const elapsed = Date.now() - start;
    if (elapsed >= RETRY_BEFORE_QUARANTINE_BUDGET_MS) return undefined;
    const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 2_000;
    const remaining = RETRY_BEFORE_QUARANTINE_BUDGET_MS - elapsed;
    await sleep(Math.max(1, Math.min(backoff, remaining)));
    try {
      return await openAndProbe(path, init);
    } catch (retryError) {
      if (isExternalAssetError(retryError, path)) throw retryError;
      if (!looksLikeIntactPGliteDirectory(path)) return undefined;
      // Otherwise loop and try again until the budget elapses.
    }
  }
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
 * True when an open failure points at a filesystem path that is not under
 * `dataDir` — i.e. the dataDir itself is fine and PGlite stumbled on one of
 * its own bundled runtime files (the canonical case is `pglite.data` being
 * momentarily missing while `npm` is rewriting `node_modules` during a duet
 * self-update). Used to suppress quarantine so we never move a healthy
 * memory.db aside because of a transient packaging error.
 */
export function isExternalAssetError(error: unknown, dataDir: string): boolean {
  if (!error || typeof error !== "object") return false;
  const errno = error as NodeJS.ErrnoException & { path?: string };
  if (errno.code !== "ENOENT") return false;
  const candidates: string[] = [];
  if (typeof errno.path === "string") candidates.push(errno.path);
  if (typeof errno.message === "string") {
    // PGlite re-throws fs errors with the path embedded in the message but
    // not always on `.path`; pull anything that looks absolute out of it.
    const match = errno.message.match(/['"]([^'"]+)['"]/);
    if (match?.[1]) candidates.push(match[1]);
  }
  if (candidates.length === 0) return false;
  const normalizedDir = resolvePath(dataDir);
  return candidates.every((candidate) => {
    const normalized = resolvePath(candidate);
    return normalized !== normalizedDir && !normalized.startsWith(`${normalizedDir}/`);
  });
}

/**
 * Subdirectories every PGlite cluster on disk has. If all of these plus a
 * parseable `PG_VERSION` are present, the dataDir's on-disk layout is
 * intact and any open failure is environmental (mid-upgrade asset rewrite,
 * permissions, WASM load) rather than data corruption.
 */
const REQUIRED_PGLITE_SUBDIRS = ["base", "global", "pg_wal"] as const;

/**
 * True when `path` looks like a valid PGlite cluster: it contains a
 * non-empty `PG_VERSION` and every directory PGlite needs to bootstrap a
 * cluster. Used as a quarantine guard so an upgrade-time WASM/data load
 * failure cannot move a healthy memory.db aside. Exported for testing.
 */
export function looksLikeIntactPGliteDirectory(path: string): boolean {
  if (!isExistingDirectory(path)) return false;
  const versionFile = join(path, "PG_VERSION");
  const version = tryReadFile(versionFile);
  if (!version || version.trim().length === 0) return false;
  return REQUIRED_PGLITE_SUBDIRS.every((sub) => isExistingDirectory(join(path, sub)));
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
    // Another opener won the race after our stale-lock takeover. Even
    // if the new holder has already exited by the time we read the
    // file (which happens with bursts of short-lived openers churning
    // through the same dataDir), we treat this as contention and let
    // the caller re-poll — throwing here would abort an otherwise
    // healthy session for what is effectively "try again in 50ms".
    const afterContents = tryReadFile(lockPath) ?? "";
    const after = Number.parseInt(afterContents.split("\n", 1)[0]?.trim() ?? "", 10);
    const reportedPid = Number.isFinite(after) && after > 0 ? after : 0;
    return { holderPid: reportedPid };
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
