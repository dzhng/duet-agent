import type { PGlite } from "@electric-sql/pglite";
import {
  DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS,
  MemoryLockTimeoutError,
  type OpenPGliteOptions,
  openPGliteHoldingLock,
  pollAcquireOpenLock,
  releaseOpenLock,
} from "./pglite.js";

/**
 * Default time the PGlite handle stays open after the last `withDb`
 * call resolves before it is closed and the cross-process lock is
 * released. Keeps short bursts of writes (observer + reflector +
 * embedding upserts in the same turn) on one open without making a
 * sitting CLI permanently hold the lock against a second CLI.
 */
const DEFAULT_IDLE_CLOSE_MS = 2_000;

export interface MemorySessionOptions {
  /** Absolute path to the PGlite data directory. */
  path: string;
  /**
   * Passed through to `openPGliteHoldingLock` on each open — typically
   * supplies `init` (migrations) and `onRecover` (quarantine surface).
   */
  openOptions: OpenPGliteOptions;
  /**
   * How long to keep the handle open after the last in-flight op
   * resolves. A new `withDb` call within this window reuses the open
   * handle and cancels the pending close. Defaults to 2s.
   */
  idleCloseMs?: number;
  /**
   * Wall-time budget for waiting on the cross-process lock before a
   * single `withDb` call gives up. On exhaustion the call resolves to
   * `undefined` and `onWarn` is invoked once. Defaults to 30s.
   */
  lockWaitBudgetMs?: number;
  /**
   * Invoked once when a `withDb` call is skipped because the lock
   * could not be acquired within `lockWaitBudgetMs`. Lets the host
   * surface a single user-visible warning instead of repeating per
   * skipped op.
   */
  onWarn?: (message: string) => void;
}

/**
 * Manages a single PGlite handle for one dataDir across many short
 * bursts of work. Refcounted opens keep the handle (and the
 * cross-process `.duet-open.lock`) alive while any `withDb` is
 * in-flight; an idle timer releases both shortly after the last op
 * resolves so a peer process can step in.
 *
 * Concurrent in-process `withDb` calls share one `PGlite.create`: the
 * first call allocates `this.opening` and every other call awaits the
 * same promise, so two opens cannot race into `init` and double-run
 * migrations against a fresh dataDir.
 */
export class MemorySession {
  private readonly path: string;
  private readonly openOptions: OpenPGliteOptions;
  private readonly idleCloseMs: number;
  private readonly lockWaitBudgetMs: number;
  private readonly onWarn?: (message: string) => void;

  private readonly writeListeners = new Set<() => void>();
  private db: PGlite | undefined;
  private lockPath: string | undefined;
  private opening: Promise<PGlite | undefined> | undefined;
  private refs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private disposing: Promise<void> | undefined;

  constructor(opts: MemorySessionOptions) {
    this.path = opts.path;
    this.openOptions = opts.openOptions;
    this.idleCloseMs = opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this.lockWaitBudgetMs = opts.lockWaitBudgetMs ?? DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS;
    if (opts.onWarn) this.onWarn = opts.onWarn;
  }

  /**
   * Run `fn` against the (lazily-opened) memory database. Returns
   * `undefined` without invoking `fn` when the session is disposed or
   * the lock could not be acquired within the budget; otherwise
   * returns whatever `fn` returns. Errors thrown inside `fn`
   * propagate.
   */
  async withDb<T>(fn: (db: PGlite) => Promise<T>): Promise<T | undefined> {
    if (this.disposed) return undefined;
    this.cancelIdleClose();
    // Increment refs before awaiting the open so a concurrent
    // `dispose()` waits for this call to finish even if the await on
    // `ensureOpen` resolves before fn runs. Without this, dispose
    // could see refs=0, close the handle, and leave fn to run against
    // a closed db.
    this.refs++;
    try {
      const db = await this.ensureOpen();
      if (!db) return undefined;
      // Once the handle is open, run fn even if dispose was called
      // while we were waiting on `ensureOpen`. dispose's drain loop
      // waits for refs to reach zero, so the call completes against
      // a still-open db; without this we would silently skip fn even
      // though the caller had already committed to running it.
      return await fn(db);
    } finally {
      this.refs--;
      if (this.refs === 0 && !this.disposed) {
        this.scheduleIdleClose();
      }
    }
  }

  /**
   * Subscribe to observation-write notifications. The storage write
   * helpers call `notifyWrite()` after landing new observation rows;
   * `loadStoredMemory` uses this to kick the embedding backfill worker
   * awake instead of having it poll the database on a timer. Returns an
   * unsubscribe function.
   */
  onWrite(listener: () => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  /**
   * Notify subscribers that observation rows were written. Called by
   * the storage write helpers after a successful write so background
   * consumers (the embedding backfill worker) wake event-driven rather
   * than polling.
   */
  notifyWrite(): void {
    if (this.disposed) return;
    for (const listener of this.writeListeners) listener();
  }

  /**
   * Wait for any in-flight `withDb` to drain, cancel a pending idle
   * close, then close the handle and release the lock. Subsequent
   * `withDb` calls resolve to `undefined`.
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.runDispose();
    return this.disposing;
  }

  private async runDispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdleClose();
    // Wait for in-flight withDb fns to settle. Polling is fine here:
    // dispose is rare and refs decrements happen on microtask
    // boundaries, so this loop spins a few times at most.
    while (this.refs > 0) {
      await sleep(5);
    }
    await this.closeNow();
  }

  private async ensureOpen(): Promise<PGlite | undefined> {
    if (this.db) return this.db;
    if (this.opening) return this.opening;
    this.opening = this.openWithPolling()
      .then((db) => {
        this.db = db;
        return db;
      })
      .catch((error: unknown) => {
        if (error instanceof MemoryLockTimeoutError) {
          this.onWarn?.("memory db busy, skipping op");
          return undefined;
        }
        throw error;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  private async openWithPolling(): Promise<PGlite> {
    const lockPath = await pollAcquireOpenLock(this.path, this.lockWaitBudgetMs);
    const opened = await openPGliteHoldingLock(this.path, this.openOptions, lockPath);
    this.lockPath = opened.lockPath;
    return opened.db;
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Re-check refs in case a new withDb arrived between the timer
      // firing and this callback running.
      if (this.refs > 0 || this.disposed) return;
      void this.closeNow();
    }, this.idleCloseMs);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async closeNow(): Promise<void> {
    const db = this.db;
    const lockPath = this.lockPath;
    this.db = undefined;
    this.lockPath = undefined;
    if (db) {
      try {
        await db.close();
      } catch {
        // PGlite occasionally throws on close after an aborted op;
        // we still need to release the lock so a peer can open.
      }
    }
    if (lockPath) releaseOpenLock(lockPath);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
