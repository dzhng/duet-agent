import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * pgvector ships with PGlite as an opt-in WASM extension. We load it
 * unconditionally so every memory database can run hybrid retrieval
 * without a feature flag dance — the cost is one extra small WASM
 * download, paid once per install. `CREATE EXTENSION vector` then
 * succeeds inside migration v3 where the embedding tables and HNSW
 * index live.
 */
const MEMORY_EXTENSIONS = { vector } as const;

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
 * Opens a PGlite database at `path`, recovering from two failure modes that
 * would otherwise leave the agent unable to start:
 *
 *   1. A stale `postmaster.pid` left by a crashed prior run — the lock is
 *      removed when its PID is not a live process.
 *   2. A data directory PGlite cannot read at all (corrupted, partially
 *      written, or written by an incompatible Postgres version) — detected
 *      by running `schemaSql` as a probe. The bad directory is renamed to
 *      `<path>.corrupted-<iso-timestamp>` so the user can recover it later,
 *      and a fresh database is opened in its place.
 *
 * Without (2) PGlite aborts with an opaque emscripten "Aborted()" error and
 * the agent is permanently wedged until the user manually deletes the data
 * directory.
 */
export async function openPGlite(path: string, options: OpenPGliteOptions = {}): Promise<PGlite> {
  mkdirSync(dirname(path), { recursive: true });
  clearStalePostmasterLock(path);

  try {
    return await openAndProbe(path, options.init);
  } catch (error) {
    if (!isExistingDirectory(path)) throw error;

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
    return await openAndProbe(path, options.init);
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
