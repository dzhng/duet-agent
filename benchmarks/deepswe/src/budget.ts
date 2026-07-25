import { DEEPSWE_ARMS } from "./config.js";

/**
 * Cushion for one request that finishes after a rollout crosses its soft stop.
 * This covers the most expensive possible request among the four pinned
 * configurations: Fable 5 at its 1M context and 128k output ceilings. It is
 * admission headroom, not a provider-side hard cap: normal Duet subagents can
 * have more than one request in flight.
 */
export const DEEPSWE_SINGLE_REQUEST_CUSHION_USD = 20;

/** Minimum campaign authorization for every soft rollout stop plus a cushion. */
export function deepSweMinimumBudgetUsd(taskCount: number, costLimitUsd: number): number {
  if (!Number.isSafeInteger(taskCount) || taskCount < 1) {
    throw new RangeError("taskCount must be a positive integer.");
  }
  if (!Number.isFinite(costLimitUsd) || costLimitUsd <= 0) {
    throw new RangeError("costLimitUsd must be positive.");
  }
  return (
    taskCount *
    Object.keys(DEEPSWE_ARMS).length *
    (costLimitUsd + DEEPSWE_SINGLE_REQUEST_CUSHION_USD)
  );
}
