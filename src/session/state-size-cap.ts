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
  /** Serialized payload bytes (utf-8) including the trailing newline the writer adds. */
  bytes: number;
}

/**
 * Single source of truth for how `state.json` is serialized. Used by both the
 * writer and the size cap so the byte count the cap measures equals the byte
 * count that lands on disk.
 */
export function serializeEnvelope(payload: StoredEnvelopeShape): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Anthropic and OpenAI both reject conversations whose first message isn't
 * `user`. Front-eviction can leave a `toolResult` (orphaned without its
 * assistant call) or an `assistant` message at the head, both of which wedge
 * the next turn on resume.
 */
function isInvalidHead(message: AgentMessage | undefined): boolean {
  if (!message || !("role" in message)) return false;
  return message.role === "toolResult" || message.role === "assistant";
}

/**
 * Returns a new envelope whose serialized size is at most `maxBytes`, evicting
 * the oldest agent messages first. After each eviction, drops any leading
 * `toolResult` or `assistant` message until the head is `user` — the only
 * role every provider accepts at position 0.
 *
 * Front-eviction preserves tool-call / tool-result pairing by construction:
 * tool results always follow their assistant call in source order, so
 * dropping an assistant naturally drops its trailing results through the
 * head-fix loop.
 *
 * Preserves:
 * - The original payload reference is not mutated.
 * - Non-message envelope fields (`todos`, `queuedCommands`, `stateMachine`,
 *   `options`, `sessionCostUsd`, `lastUsage`).
 *
 * Stops once `messages.length <= MIN_RETAINED_MESSAGES`. If the remainder
 * still exceeds `maxBytes`, the caller writes the oversize file: a truncated
 * but recoverable transcript beats a wedged session.
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
    // Non-message bloat (e.g. enormous queuedCommands). Nothing this layer
    // can do — write it through and let the next layer decide.
    return { payload: current, evicted: 0, bytes: serialized.length };
  }

  const trimmed: AgentMessage[] = [...messages];
  let evicted = 0;

  while (serialized.length > maxBytes && trimmed.length > MIN_RETAINED_MESSAGES) {
    trimmed.shift();
    evicted += 1;
    while (trimmed.length > MIN_RETAINED_MESSAGES && isInvalidHead(trimmed[0])) {
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
