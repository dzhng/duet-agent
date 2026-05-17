import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnState, TurnUsageFields } from "../types/protocol.js";

/**
 * Default ceiling for the on-disk `state.json`. State that survives across
 * resumes keeps growing as tool calls and tool results accumulate. Without a
 * cap, long-lived sessions eventually produce multi-hundred-MB files that
 * slow every persist and hydrate, and risk filling the user's disk.
 *
 * 100 MB matches duet-agent's session contract: enough headroom for hours of
 * dense tool-call work, small enough that load+parse stays under a second on
 * commodity hardware. Adjustable in tests, not at runtime.
 */
export const STATE_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Even when a single message exceeds the cap, keep at least this many
 * messages so the next turn still has anchor context. The runner can recover
 * from a truncated transcript, but not from an empty one.
 */
export const MIN_RETAINED_MESSAGES = 1;

export interface StoredEnvelopeShape {
  sessionId?: string;
  updatedAt?: number;
  state?: TurnState;
  lastUsage?: TurnUsageFields;
  sessionCostUsd?: number;
}

export interface EnforceResult<T extends StoredEnvelopeShape> {
  payload: T;
  evicted: number;
  /** Serialized payload bytes (utf-8) including the trailing newline writeStoredEnvelope adds. */
  bytes: number;
}

/**
 * Serialize the same way `writeStoredEnvelope` does so byte counts match the
 * file actually written. Centralized so the size cap and the writer can never
 * drift.
 */
export function serializeEnvelope(payload: StoredEnvelopeShape): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Returns true when the message is a tool result. A leading tool result with no
 * preceding assistant tool call is orphaned: most providers reject it on
 * resume, and the duet-agent runner has no way to reconstruct the missing
 * call. We drop these alongside the eviction so the head of the transcript
 * stays valid.
 */
function isToolResult(message: AgentMessage | undefined): boolean {
  return message?.role === "toolResult";
}

/**
 * Returns a new envelope whose serialized size is at most `maxBytes`, evicting
 * the oldest agent messages first. When the head of the transcript becomes a
 * tool-result message after eviction, drop it too — a tool result without its
 * originating assistant call is rejected by every provider we ship.
 *
 * Preserves:
 * - The original payload reference is not mutated. State and agent are cloned
 *   on the path that changes.
 * - Non-message fields (todos, queuedCommands, stateMachine, options,
 *   sessionCostUsd, lastUsage). Trimming only touches `state.agent.messages`.
 *
 * Stops once `messages.length <= MIN_RETAINED_MESSAGES`. If the remaining
 * payload still exceeds `maxBytes`, the caller writes the oversize file: a
 * truncated-but-recoverable transcript beats a wedged session.
 */
export function enforceStateSizeCap<T extends StoredEnvelopeShape>(
  payload: T,
  maxBytes: number = STATE_FILE_MAX_BYTES,
): EnforceResult<T> {
  let current: T = payload;
  let serialized = serializeEnvelope(current);
  if (serialized.length <= maxBytes) {
    return { payload: current, evicted: 0, bytes: serialized.length };
  }

  const messages = current.state?.agent?.messages;
  if (!messages || messages.length === 0) {
    // Nothing to trim — non-message bloat (e.g. enormous queuedCommands).
    return { payload: current, evicted: 0, bytes: serialized.length };
  }

  let trimmed: AgentMessage[] = [...messages];
  let evicted = 0;

  while (serialized.length > maxBytes && trimmed.length > MIN_RETAINED_MESSAGES) {
    trimmed.shift();
    evicted += 1;
    while (trimmed.length > MIN_RETAINED_MESSAGES && isToolResult(trimmed[0])) {
      trimmed.shift();
      evicted += 1;
    }
    current = rewriteMessages(current, trimmed);
    serialized = serializeEnvelope(current);
  }

  return { payload: current, evicted, bytes: serialized.length };
}

function rewriteMessages<T extends StoredEnvelopeShape>(payload: T, messages: AgentMessage[]): T {
  const state = payload.state;
  if (!state) return payload;
  return {
    ...payload,
    state: {
      ...state,
      agent: {
        ...state.agent,
        messages,
      },
    },
  };
}
