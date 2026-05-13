/**
 * Detect transient upstream/transport errors and apply local retry policy.
 *
 * pi-agent surfaces provider failures as the last assistant message having
 * `stopReason: "error"` and an `errorMessage` string. Most failure shapes are
 * terminal (auth, bad request, model not found, refusal). A subset — gateway
 * 5xx responses, transient transport drops, websocket closes, "overloaded"
 * markers from Anthropic, retry-after exhaustion — should be retried locally:
 * they routinely succeed on a second attempt and would otherwise fail a
 * long-running state-machine state over a brief proxy hiccup.
 *
 * ## Why a local helper instead of pi's built-in retry?
 *
 * The pi monorepo already ships a retry loop in
 * `@earendil-works/pi-coding-agent`'s `AgentSession` (see
 * `_isRetryableError` and `_handleRetryableError` in
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`).
 * It pops the failure assistant message, waits with exponential backoff,
 * calls `agent.continue()`, and emits `auto_retry_start`/`auto_retry_end`
 * events.
 *
 * TurnRunner intentionally drives `Agent` directly rather than going
 * through `AgentSession` so it can own turn semantics (steer queues,
 * state-machine routing, parent vs sub-agent transcripts, memory
 * transforms, wire-shaping). That means the `AgentSession` retry path
 * does not apply to us. This module deliberately mirrors `AgentSession`'s
 * detection regex (with the same context-overflow exclusion) so transient
 * failures retry consistently whether a caller uses pi-coding-agent or
 * duet-agent. Patterns covered:
 *
 * - HTTP 429/500/502/503/504 with or without a "status code (no body)"
 *   prefix.
 * - Anthropic "overloaded" markers and generic "provider returned error"
 *   wrappers.
 * - Transport/socket failures: `fetch failed`, `socket hang up`, `ECONN*`,
 *   `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, "connection lost".
 * - HTTP/2 and websocket churn: "websocket closed", "other side closed",
 *   "reset before headers", "http2 request did not get a response",
 *   "ended without sending chunks", "terminated".
 * - Timeouts: "request timed out", generic "timeout", "retry delay" (the
 *   marker pi-ai emits when `maxRetryDelayMs` is exceeded so higher-level
 *   logic can take over).
 *
 * Context-overflow errors are handled by `tryRecoverFromContextOverflow`
 * and intentionally skipped here. Client errors (4xx other than 429) are
 * not retried because retrying with the same payload will not change the
 * outcome.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Combined transient-error pattern. Kept in one regex to mirror
 * pi-coding-agent's `_isRetryableError` so behavior stays consistent
 * between the two retry sites in the pi ecosystem.
 */
const TRANSIENT_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bETIMEDOUT\b|\bEPIPE\b|\bEAI_AGAIN\b/i;

/**
 * Patterns excluded even when `TRANSIENT_PATTERN` matches. These are
 * client-side failures whose payload would fail identically on retry.
 * 4xx codes other than 429 are blocked here; 429 is intentionally retried
 * because the server is asking the caller to back off and try again.
 */
const NON_RETRYABLE_PATTERN =
  /\b(?:400|401|402|403|404|405|406|407|408|410|411|412|413|414|415|416|417|418|421|422|423|424|425|426|428|431|451)\b|\bunauthorized\b|\bforbidden\b|\bnot found\b/i;

/**
 * Returns true when `errorMessage` looks like a transient gateway/transport
 * failure that another attempt may resolve. Returns false for client errors
 * and any message that does not clearly indicate a server-side fault.
 */
export function isTransientServerError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (NON_RETRYABLE_PATTERN.test(errorMessage)) return false;
  return TRANSIENT_PATTERN.test(errorMessage);
}

/**
 * True when the last assistant message in `messages` is a transient-error
 * failure that recovery can pop and retry via `agent.continue()`.
 */
export function lastMessageIsTransientFailure(messages: AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (last.stopReason !== "error") return false;
  return isTransientServerError(last.errorMessage);
}

/**
 * Retry policy applied to both the parent agent and state-machine sub-agents.
 *
 * - `maxAttempts` counts total prompt+continue attempts, so `3` means the
 *   initial prompt plus up to two retries.
 * - `baseDelayMs` is the first retry's delay; subsequent retries double it
 *   (with jitter) up to `maxDelayMs`.
 *
 * Defaults mirror `AgentSession`'s defaults (3 retries, 2s base) so the
 * two retry sites in the pi ecosystem stay in sync.
 */
export interface TransientRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_TRANSIENT_RETRY_POLICY: TransientRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

export function transientRetryDelayMs(
  attempt: number,
  policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY_POLICY,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * 0.25 * Math.random();
  return Math.round(capped + jitter);
}
