/**
 * Best-of-N capability gate for live-model evals. A single binary trial of
 * live executor behavior is a coin flip on hard fixtures (observed across the
 * advisor, step-trigger, and mixed-task acceptance runs); retrying a bounded
 * number of times converts "did the model happen to do it this run" into
 * "can the shipped configuration do it". Keep restraint-style cases (where
 * the failure mode is the model DOING something) single-run strict — a retry
 * there masks exactly what the case exists to catch.
 */
export async function bestOfAttempts(attempts: number, run: () => Promise<void>): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure;
}
