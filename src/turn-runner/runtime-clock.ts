export type CancelScheduled = () => void;

/** Wall-time operations used by task and scheduled-state lifecycles. */
export interface RuntimeClock {
  /** Return the current Unix-epoch timestamp in milliseconds. */
  now(): number;
  /** Resolve after `ms`, or reject with the abort reason when `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Run `callback` once after `delayMs`; the returned function cancels it. */
  schedule(callback: () => void, delayMs: number): CancelScheduled;
  /** Run `callback` every `intervalMs`; the returned function cancels future runs. */
  repeat(callback: () => void, intervalMs: number): CancelScheduled;
}

/** Production clock backed by the host wall clock and timer APIs. */
export class SystemRuntimeClock implements RuntimeClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  schedule(callback: () => void, delayMs: number): CancelScheduled {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }

  repeat(callback: () => void, intervalMs: number): CancelScheduled {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
