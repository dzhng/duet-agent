export interface FakeTaskWorkInput {
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export type FakeTaskWorkSettlement<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown };

/** Deferred task work whose lifecycle is completely controlled by a unit test. */
export interface FakeTaskWork<T> {
  readonly starts: number;
  readonly outputChunks: readonly string[];
  readonly abortSignal: AbortSignal | undefined;
  readonly abortReason: unknown;
  readonly cleanupCompleted: boolean;
  readonly settlement: FakeTaskWorkSettlement<T> | undefined;
  run(input: FakeTaskWorkInput): Promise<T>;
  emitOutput(chunk: string): void;
  resolve(value: T): void;
  reject(error: unknown): void;
  completeCleanup(): void;
}

export function createFakeTaskWork<T = string>(): FakeTaskWork<T> {
  let starts = 0;
  const outputChunks: string[] = [];
  let activeInput: FakeTaskWorkInput | undefined;
  let abortSignal: AbortSignal | undefined;
  let abortReason: unknown;
  let cleanupCompleted = false;
  let settlement: FakeTaskWorkSettlement<T> | undefined;
  const work = deferred<T>();
  const cleanup = deferred<void>();

  const run = async (input: FakeTaskWorkInput): Promise<T> => {
    starts += 1;
    activeInput = input;
    abortSignal = input.signal;

    const abort = () => {
      abortReason = input.signal.reason;
      void cleanup.promise.then(() => work.reject(abortReason));
    };
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });

    try {
      const value = await work.promise;
      settlement = { status: "completed", value };
      return value;
    } catch (error) {
      settlement = { status: "failed", error };
      throw error;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  };

  return {
    get starts() {
      return starts;
    },
    get outputChunks() {
      return outputChunks;
    },
    get abortSignal() {
      return abortSignal;
    },
    get abortReason() {
      return abortReason;
    },
    get cleanupCompleted() {
      return cleanupCompleted;
    },
    get settlement() {
      return settlement;
    },
    run,
    emitOutput(chunk) {
      if (!activeInput) throw new Error("Fake task work has not started");
      outputChunks.push(chunk);
      activeInput.onOutput?.(chunk);
    },
    resolve(value) {
      work.resolve(value);
    },
    reject(error) {
      work.reject(error);
    },
    completeCleanup() {
      cleanupCompleted = true;
      cleanup.resolve();
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
