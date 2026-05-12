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
 * Refcounted entry in the in-process open-handle map. Two concurrent
 * `openPGlite` calls on the same dataDir share one PGlite instance and
 * one cross-process file lock; each caller's `close()` decrements the
 * refcount, and the underlying handle + lock are released only when
 * the last caller closes.
 *
 * Without this, two concurrent opens both passed the stale-lock check
 * and both entered `PGlite.create` on a fresh dataDir, double-running
 * migrations and corrupting the directory. The next open then aborted
 * inside the wasm runtime and `quarantineDataDirectory` renamed the
 * directory aside — that was the user-visible "memory reset".
 */
interface SharedHandle {
  promise: Promise<PGlite>;
  refs: number;
  /** Once resolved, retained so close-wrappers can release the lock and tear down. */
  db?: PGlite;
  /** Path of the cross-process lock file held while the handle is open. */
  lockPath?: string;
}

const sharedHandles = new Map<string, SharedHandle>();

let exitHandlerInstalled = false;
function installExitCleanup(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // Last-chance cleanup: if the process exits before every caller's
  // `close()` runs, drop any locks we still hold so the next launch
  // can open the database without tripping the stale-lock check.
  process.on("exit", () => {
    for (const entry of sharedHandles.values()) {
      if (entry.lockPath) {
        try {
          unlinkSync(entry.lockPath);
        } catch {
          // Best-effort on exit; nothing to do if the file is already gone.
        }
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
 *   3. Two opens racing on a fresh dataDir — historically both could pass
 *      the stale-lock check, both call `PGlite.create`, and both run the
 *      init hook concurrently, corrupting the dataDir. Now serialized by
 *      an in-process refcounted handle plus an `O_EXCL` lock file scoped
 *      to the dataDir.
 *
 * Without (2) PGlite aborts with an opaque emscripten "Aborted()" error and
 * the agent is permanently wedged until the user manually deletes the data
 * directory.
 */
export async function openPGlite(path: string, options: OpenPGliteOptions = {}): Promise<PGlite> {
  installExitCleanup();
  const key = resolvePath(path);

  const existing = sharedHandles.get(key);
  if (existing) {
    existing.refs++;
    try {
      const db = await existing.promise;
      return wrapClose(db, key);
    } catch (error) {
      decrementAndMaybeDelete(key);
      throw error;
    }
  }

  const entry: SharedHandle = {
    promise: undefined as unknown as Promise<PGlite>,
    refs: 1,
  };
  entry.promise = openWithLock(path, options, entry);
  sharedHandles.set(key, entry);

  try {
    const db = await entry.promise;
    return wrapClose(db, key);
  } catch (error) {
    decrementAndMaybeDelete(key);
    throw error;
  }
}

/**
 * Returns the same PGlite instance to every shared-handle caller, but
 * replaces `close` with a refcounting wrapper so the underlying handle
 * and cross-process lock survive until the last caller releases. The
 * wrapper is idempotent per caller — calling `close` twice on the same
 * wrapped reference is treated as a single release.
 */
function wrapClose(db: PGlite, key: string): PGlite {
  let released = false;
  const originalClose = db.close.bind(db);
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          if (released) return;
          released = true;
          await releaseShared(key, originalClose);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function releaseShared(key: string, originalClose: () => Promise<void>): Promise<void> {
  const entry = sharedHandles.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  sharedHandles.delete(key);
  try {
    await originalClose();
  } finally {
    if (entry.lockPath) {
      bestEffortUnlink(entry.lockPath);
      entry.lockPath = undefined;
    }
  }
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function decrementAndMaybeDelete(key: string): void {
  const entry = sharedHandles.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  sharedHandles.delete(key);
  if (entry.lockPath) {
    try {
      unlinkSync(entry.lockPath);
    } catch {
      // Lock may never have been created if we threw before acquireOpenLock returned.
    }
  }
}

async function openWithLock(
  path: string,
  options: OpenPGliteOptions,
  entry: SharedHandle,
): Promise<PGlite> {
  mkdirSync(dirname(path), { recursive: true });
  clearStalePostmasterLock(path);
  entry.lockPath = acquireOpenLock(path);

  try {
    const db = await openAndProbe(path, options.init);
    entry.db = db;
    return db;
  } catch (error) {
    if (!isExistingDirectory(path)) throw error;

    // Release the lock before renaming the directory aside — the lock
    // file lives inside that directory and would be moved with it.
    if (entry.lockPath) {
      bestEffortUnlink(entry.lockPath);
      entry.lockPath = undefined;
    }

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

    entry.lockPath = acquireOpenLock(path);
    const db = await openAndProbe(path, options.init);
    entry.db = db;
    return db;
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
 * Does not participate in the shared-handle / open-lock machinery; the
 * caller owns the returned instance and is responsible for `close()`.
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
 * Acquire an exclusive open-lock at `<dataDir>/.duet-open.lock`. Creates
 * `dataDir` if missing. The lock is created with `O_EXCL` so a parallel
 * acquirer either wins outright or sees `EEXIST`; on `EEXIST` we read
 * the pid line and only steal the lock if that pid is no longer alive.
 *
 * Throws with a clear message when the lock is held by a live foreign
 * process so the caller fails fast instead of double-opening the dataDir.
 */
export function acquireOpenLock(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, OPEN_LOCK_FILE);
  return createLockFile(lockPath) ?? stealStaleLock(dataDir, lockPath);
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

function stealStaleLock(dataDir: string, lockPath: string): string {
  const contents = tryReadFile(lockPath) ?? "";
  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const holderPid = Number.parseInt(firstLine, 10);
  if (
    Number.isFinite(holderPid) &&
    holderPid > 0 &&
    holderPid !== process.pid &&
    isProcessAlive(holderPid)
  ) {
    throw new Error(
      `PGlite data directory ${dataDir} is locked by another duet process (pid ${holderPid}). ` +
        "Stop that process before opening the database.",
    );
  }
  // Stale (crashed prior run) or our own pid from a partially-cleaned
  // failed open. Replace atomically — unlink-then-create-with-O_EXCL.
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const created = createLockFile(lockPath);
  if (!created) {
    throw new Error(
      `Failed to acquire open lock at ${lockPath}: another opener won the race after the stale-lock takeover.`,
    );
  }
  return created;
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
