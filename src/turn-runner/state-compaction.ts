import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnState } from "../types/protocol.js";

/**
 * Default ceiling for auto state compaction, in bytes of serialized
 * `TurnState`. Long-lived sessions accumulate tool calls and tool results
 * forever; without a cap, every emit and every disk persist eventually drags
 * on a multi-hundred-MB transcript.
 *
 * 100 MB is enough headroom for hours of dense tool-call work, small enough
 * that emit/persist stay snappy on commodity hardware. Adjustable per-runner
 * via `TurnRunnerConfig.autoStateCompaction.maxBytes`.
 */
export const DEFAULT_STATE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Even when a single message exceeds the cap, keep at least this many
 * messages so the next turn still has anchor context. The runner can recover
 * from a truncated transcript, but not from an empty one.
 */
export const MIN_RETAINED_MESSAGES = 1;

export interface AutoStateCompactionOptions {
  /** Hard ceiling for `JSON.stringify(state).length`. Defaults to 100 MB. */
  maxBytes?: number;
}

export interface CompactionResult {
  state: TurnState;
  evicted: number;
  /** Serialized byte length after compaction, for caller logging/metrics. */
  bytes: number;
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
 * Returns a new `TurnState` whose serialized size is at most `maxBytes`,
 * evicting the oldest agent messages first. After each eviction, drops any
 * leading `toolResult` or `assistant` message until the head is `user` — the
 * only role every provider accepts at position 0.
 *
 * Front-eviction preserves tool-call / tool-result pairing by construction:
 * tool results always follow their assistant call in source order, so
 * dropping an assistant naturally drops its trailing results through the
 * head-fix loop.
 *
 * Preserves the original state reference (no mutation) and every non-message
 * field on `TurnState` and `state.agent` (`status`, `mode`, `options`,
 * `stateMachine`, `todos`, `followUpQueue`, `queuedCommands`).
 *
 * Stops once `messages.length <= MIN_RETAINED_MESSAGES`. If the remainder
 * still exceeds `maxBytes`, the caller persists/emits the oversize state: a
 * truncated but recoverable transcript beats a wedged session.
 */
export function compactTurnState(
  state: TurnState,
  options: AutoStateCompactionOptions = {},
): CompactionResult {
  const maxBytes = options.maxBytes ?? DEFAULT_STATE_MAX_BYTES;
  let serialized = JSON.stringify(state);
  if (serialized.length <= maxBytes) {
    return { state, evicted: 0, bytes: serialized.length };
  }

  const messages = state.agent?.messages;
  if (!messages || messages.length === 0) {
    // Non-message bloat (e.g. enormous queuedCommands). Nothing this layer
    // can do.
    return { state, evicted: 0, bytes: serialized.length };
  }

  const trimmed: AgentMessage[] = [...messages];
  let current: TurnState = state;
  let evicted = 0;

  while (serialized.length > maxBytes && trimmed.length > MIN_RETAINED_MESSAGES) {
    trimmed.shift();
    evicted += 1;
    while (trimmed.length > MIN_RETAINED_MESSAGES && isInvalidHead(trimmed[0])) {
      trimmed.shift();
      evicted += 1;
    }
    current = { ...current, agent: { ...current.agent, messages: trimmed } };
    serialized = JSON.stringify(current);
  }

  return { state: current, evicted, bytes: serialized.length };
}
