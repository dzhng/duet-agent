import type { ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Canonical list of pi-ai `ThinkingLevel` values, in ascending intensity.
 * Kept as a runtime constant so callers can both validate user input and
 * surface the legal values in error messages without duplicating the
 * upstream type. The `satisfies` clause guarantees the literal array
 * stays in lockstep with the upstream union.
 */
export const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

/** Narrowing type guard for arbitrary strings into `ThinkingLevel`. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize and validate a user-supplied thinking level. Trims surrounding
 * whitespace and lowercases the value before comparison so CLI / TUI input
 * does not need its own cleanup pass. Throws with the legal values listed
 * when the input does not match any known level.
 */
export function validateThinkingLevel(raw: string): ThinkingLevel {
  const normalized = raw.trim().toLowerCase();
  if (!isThinkingLevel(normalized)) {
    throw new Error(
      `Unknown thinking level: ${raw}. Expected one of ${THINKING_LEVELS.join(", ")}.`,
    );
  }
  return normalized;
}
