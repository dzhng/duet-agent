import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

/** Locks older than this are assumed to belong to a terminated process. */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

export interface FileLockHandle {
  /** Open descriptor that keeps the lock file owned until release. */
  fd: number;
  /** Exact file to unlink when the protected operation finishes. */
  lockPath: string;
}

export interface AcquireFileLockOptions {
  /** Current wall-clock time, injectable so stale-lock behavior is deterministic in tests. */
  now?: number;
  /** Age after which an abandoned lock may be reclaimed. */
  staleAfterMs?: number;
}

interface LockPayload {
  pid: number;
  startedAt: number;
}

/**
 * Try once to own an advisory lock file, reclaiming one stale lock if needed.
 * Callers that require waiting retry this primitive on their own budget.
 */
export function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): FileLockHandle | null {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now } satisfies LockPayload));
      return { fd, lockPath };
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) return null;
      if (!isStaleLock(lockPath, now, staleAfterMs)) return null;
      try {
        unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Close and remove a lock. Release is best-effort so cleanup cannot mask the protected result. */
export function releaseFileLock(handle: FileLockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // The descriptor may already be closed after an interrupted operation.
  }
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // A missing lock is already released.
  }
}

function isStaleLock(lockPath: string, now: number, staleAfterMs: number): boolean {
  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
    if (typeof payload.startedAt === "number") return now - payload.startedAt > staleAfterMs;
  } catch {
    // Fall through to the mtime check: an unreadable payload may be a holder
    // caught between creating the file and writing it, not a dead process.
  }
  // Unreadable or payload-free locks go stale by file age, never instantly —
  // reclaiming a lock mid-write would let two writers race the store.
  try {
    return now - statSync(lockPath).mtimeMs > staleAfterMs;
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
