import type { CancelScheduled, RuntimeClock } from "../../../../src/turn-runner/runtime-clock.js";

interface ScheduledCallback {
  readonly callback: () => void;
  readonly insertionOrder: number;
  readonly intervalMs?: number;
  deadline: number;
  cancelled: boolean;
}

/** Deterministic clock for benchmark-client deadlines without wall-clock waits. */
export class ManualRuntimeClock implements RuntimeClock {
  private currentTimeMs: number;
  private nextInsertionOrder = 0;
  private readonly scheduled = new Set<ScheduledCallback>();

  constructor(initialTimeMs = 0) {
    this.currentTimeMs = initialTimeMs;
  }

  now(): number {
    return this.currentTimeMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const cancel = this.schedule(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        cancel();
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  schedule(callback: () => void, delayMs: number): CancelScheduled {
    return this.addScheduled(callback, delayMs);
  }

  repeat(callback: () => void, intervalMs: number): CancelScheduled {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a finite positive number");
    }
    return this.addScheduled(callback, intervalMs, intervalMs);
  }

  async advanceBy(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("ms must be a finite non-negative number");
    }
    const targetTimeMs = this.currentTimeMs + ms;
    while (true) {
      const next = this.nextDueCallback(targetTimeMs);
      if (!next) break;
      this.currentTimeMs = next.deadline;
      if (next.intervalMs === undefined) this.scheduled.delete(next);
      next.callback();
      await Promise.resolve();
      if (next.intervalMs !== undefined && !next.cancelled) next.deadline += next.intervalMs;
    }
    this.currentTimeMs = targetTimeMs;
    await Promise.resolve();
  }

  private addScheduled(
    callback: () => void,
    delayMs: number,
    intervalMs?: number,
  ): CancelScheduled {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("delayMs must be a finite non-negative number");
    }
    const scheduled: ScheduledCallback = {
      callback,
      deadline: this.currentTimeMs + delayMs,
      insertionOrder: this.nextInsertionOrder++,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      cancelled: false,
    };
    this.scheduled.add(scheduled);
    return () => {
      scheduled.cancelled = true;
      this.scheduled.delete(scheduled);
    };
  }

  private nextDueCallback(targetTimeMs: number): ScheduledCallback | undefined {
    let next: ScheduledCallback | undefined;
    for (const candidate of this.scheduled) {
      if (candidate.cancelled || candidate.deadline > targetTimeMs) continue;
      if (
        !next ||
        candidate.deadline < next.deadline ||
        (candidate.deadline === next.deadline && candidate.insertionOrder < next.insertionOrder)
      ) {
        next = candidate;
      }
    }
    return next;
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
