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
 * Returns true when the head of a transcript would be rejected by the next
 * LLM call. Anthropic and OpenAI both require the first message in a
 * conversation to be `user`. After eviction the head can be:
 *
 * - `toolResult` — orphaned (no preceding assistant tool call) and rejected
 *   by every provider.
 * - `assistant` — violates the "first message must be user" rule.
 *
 * Either one wedges the next turn on resume, so we keep dropping until the
 * head is a user message (or we hit the retention floor).
 */
function isInvalidHead(message: AgentMessage | undefined): boolean {
  if (!message) return false;
  const role = (message as { role?: string }).role;
  return role === "toolResult" || role === "assistant";
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
  let evicted = 0;

  // Integrity sweep on every write, before checking the byte cap. A corrupted
  // input transcript (orphan tool result anywhere, not just at the head)
  // wedges the next LLM call regardless of byte count. Cheap O(n) walk, no
  // JSON.stringify.
  const initialMessages = current.state?.agent?.messages ?? [];
  if (initialMessages.length > 0) {
    const sweep = dropOrphanToolResults([...initialMessages]);
    if (sweep.dropped > 0) {
      evicted += sweep.dropped;
      current = rewriteMessages(current, sweep.messages);
    }
  }

  let serialized = serializeEnvelope(current);
  if (serialized.length <= maxBytes) {
    return { payload: current, evicted, bytes: serialized.length };
  }

  const messages = current.state?.agent?.messages;
  if (!messages || messages.length === 0) {
    // Nothing to trim — non-message bloat (e.g. enormous queuedCommands).
    return { payload: current, evicted, bytes: serialized.length };
  }

  let trimmed: AgentMessage[] = [...messages];

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

  // Defensive integrity sweep. Front-eviction maintains tool-call/tool-result
  // pairing as an invariant (results always follow their assistant call, so
  // dropping the assistant naturally drops its trailing results via the head
  // loop above), but providers reject any transcript with a half-pair, and
  // we never want a disk safety net to be the thing that wedges a session.
  // Scrub any orphan tool-result whose matching assistant tool-call id isn't
  // in the kept transcript.
  const sweptOrphans = dropOrphanToolResults(trimmed);
  if (sweptOrphans.dropped > 0) {
    evicted += sweptOrphans.dropped;
    current = rewriteMessages(current, sweptOrphans.messages);
    serialized = serializeEnvelope(current);
  }

  return { payload: current, evicted, bytes: serialized.length };
}

/**
 * Removes any `toolResult` whose `toolCallId` doesn't match a `toolCall` block
 * emitted by a kept `assistant` message. Returns the cleaned list and how
 * many were dropped. Walks left-to-right so a tool result is only kept if its
 * call appeared earlier in the surviving transcript.
 */
function dropOrphanToolResults(messages: AgentMessage[]): {
  messages: AgentMessage[];
  dropped: number;
} {
  const seenCallIds = new Set<string>();
  const kept: AgentMessage[] = [];
  let dropped = 0;
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "toolCall"
          ) {
            const id = (block as { toolCallId?: string }).toolCallId;
            if (typeof id === "string") seenCallIds.add(id);
          }
        }
      }
      kept.push(message);
      continue;
    }
    if (role === "toolResult") {
      const id = (message as { toolCallId?: string }).toolCallId;
      if (typeof id === "string" && !seenCallIds.has(id)) {
        dropped += 1;
        continue;
      }
    }
    kept.push(message);
  }
  return { messages: kept, dropped };
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
