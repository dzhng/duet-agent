import ms from "ms";

import type { StateMachinePollState, StateMachineTimerState } from "../types/state-machine.js";

/**
 * Parse a duration value into milliseconds.
 *
 * State-machine schedule fields (poll `interval`, timer `wakeAfter`) accept
 * either:
 * - a number (raw milliseconds; the legacy form so existing definitions and
 *   programmatic callers keep working), or
 * - a human-readable duration string parsed by the `ms` package — for example
 *   `"30s"`, `"15m"`, `"3h"`, `"5d"`, `"2 weeks"`.
 *
 * Returns the resolved millisecond value, or throws when the input is neither
 * a finite positive number nor a parseable duration string.
 */
export function parseDurationToMs(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive, finite number of milliseconds.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a non-empty duration string (e.g. "3h", "5d").`);
    }
    const parsed = ms(trimmed as ms.StringValue);
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `${label} could not parse duration string ${JSON.stringify(value)}. Use forms like "30s", "15m", "3h", "5d", or a positive number of milliseconds.`,
      );
    }
    return parsed;
  }
  throw new Error(
    `${label} must be a duration string (e.g. "3h") or a positive number of milliseconds.`,
  );
}

/**
 * Parse an absolute wake target into a Unix-epoch millisecond timestamp.
 *
 * Timer `wakeAt` accepts either:
 * - a number (Unix-epoch milliseconds; the legacy form), or
 * - an ISO 8601 / RFC 3339 / any `Date.parse`-compatible string — for example
 *   `"2026-05-24T18:00:00Z"` or `"2026-05-24 18:00"`.
 *
 * Returns the resolved epoch-ms value, or throws when the input is neither a
 * finite number nor a parseable date string.
 */
export function parseWakeAtToMs(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite Unix-epoch millisecond timestamp.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a non-empty ISO date string.`);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `${label} could not parse date string ${JSON.stringify(value)}. Use an ISO 8601 timestamp like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number.`,
      );
    }
    return parsed;
  }
  throw new Error(
    `${label} must be an ISO date string (e.g. "2026-05-24T18:00:00Z") or a Unix-epoch millisecond number.`,
  );
}

/**
 * Best-effort wake-time fallback used by sleep-event replay paths that lack
 * controller context. Returns `Date.now()` when the underlying value cannot be
 * parsed instead of throwing, because these callers are reconstructing UI
 * banners rather than enforcing schedule validity (the controller path runs
 * its own strict parsing on every state entry).
 */
export function scheduledStateFallbackWakeAt(
  state: StateMachinePollState | StateMachineTimerState | undefined,
): number {
  if (!state) return Date.now();
  try {
    if (state.kind === "poll") {
      return Date.now() + parseDurationToMs(state.intervalMs, "intervalMs");
    }
    if (state.wakeAt !== undefined) {
      return parseWakeAtToMs(state.wakeAt, "wakeAt");
    }
    if (state.wakeAfterMs !== undefined) {
      return Date.now() + parseDurationToMs(state.wakeAfterMs, "wakeAfterMs");
    }
  } catch {
    // Fall through to Date.now() — the strict path on the controller will
    // surface the real error when the state is next entered.
  }
  return Date.now();
}
