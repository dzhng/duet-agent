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
 * Fraction of the parent agent's effective context window that the on-demand
 * `compact` command targets for the surviving wire-tail. 20% is an
 * intentionally aggressive ceiling: it leaves the remaining 80% of the
 * window for the system prompt, memory packs, the next user prompt, and
 * the next assistant response, so a freshly compacted session has real
 * headroom for the next turn instead of immediately bumping the
 * auto-compaction ceiling again. The runner consumes this via the
 * wire-shaping `WireGuardHorizon`; nothing on disk changes.
 */
export const COMPACT_MESSAGE_TOKENS_RATIO = 0.2;

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

function taskIdsReferencedBy(message: AgentMessage): Set<string> {
  return new Set(JSON.stringify(message).match(/\bt\d+\b/g) ?? []);
}

function toolCallIds(message: AgentMessage): Set<string> {
  if (!("role" in message) || message.role !== "assistant" || !("content" in message)) {
    return new Set();
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return new Set(
    content.flatMap((block) => {
      if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") {
        return [];
      }
      const candidate = block as { id?: unknown; toolCallId?: unknown };
      const id = candidate.id ?? candidate.toolCallId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/**
 * Find both messages in every tool-call/result pair whose result carries a
 * live task id. A result can be separated from its assistant call by sibling
 * results, so match the structural tool-call id rather than adjacency.
 */
function findLiveTaskPairMessages(
  state: TurnState,
  messages: readonly AgentMessage[],
): Set<AgentMessage> {
  const liveTaskIds = new Set<string>(
    (state.tasks ?? [])
      .filter(({ status }) => status === "running" || status === "scheduled")
      .map(({ id }) => id),
  );
  const pinned = new Set<AgentMessage>();
  if (liveTaskIds.size === 0) return pinned;

  for (let resultIndex = 0; resultIndex < messages.length; resultIndex += 1) {
    const result = messages[resultIndex];
    if (!result || !("role" in result) || result.role !== "toolResult") continue;
    const referencesLiveTask = [...taskIdsReferencedBy(result)].some((id) => liveTaskIds.has(id));
    if (!referencesLiveTask) continue;

    const resultCallId = "toolCallId" in result ? result.toolCallId : undefined;
    if (typeof resultCallId !== "string") continue;
    for (let callIndex = resultIndex - 1; callIndex >= 0; callIndex -= 1) {
      const call = messages[callIndex];
      if (!call) continue;
      if (toolCallIds(call).has(resultCallId)) {
        pinned.add(call);
        pinned.add(result);
        break;
      }
    }
  }
  return pinned;
}

/**
 * Returns a new `TurnState` whose serialized size is at most `maxBytes`,
 * evicting the oldest agent messages first. After each eviction, drops any
 * leading `toolResult` or `assistant` message until the head is `user` — the
 * only role every provider accepts at position 0.
 *
 * Front-eviction preserves tool-call / tool-result pairing by construction.
 * When a result carries a live task id, both sides of that pair are pinned:
 * the full invalid-head cascade is inspected before removal, and compaction
 * stops at the preceding valid boundary rather than split or evict the pair.
 * `TurnState.tasks` remains authoritative if no transcript pair can be found.
 *
 * Preserves the original state reference (no mutation) and every non-message
 * field on `TurnState` and `state.agent` (`status`, `mode`, `options`,
 * `stateMachine`, `todos`, `followUpQueue`, `queuedCommands`, `tasks`, and
 * `nextTaskId`).
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
  const pinned = findLiveTaskPairMessages(state, messages);
  let current: TurnState = state;
  let evicted = 0;

  while (serialized.length > maxBytes && trimmed.length > MIN_RETAINED_MESSAGES) {
    let removeCount = 1;
    while (
      trimmed.length - removeCount > MIN_RETAINED_MESSAGES &&
      isInvalidHead(trimmed[removeCount])
    ) {
      removeCount += 1;
    }
    const removal = trimmed.slice(0, removeCount);
    if (removal.some((message) => pinned.has(message))) break;
    trimmed.splice(0, removeCount);
    evicted += removeCount;
    current = { ...current, agent: { ...current.agent, messages: trimmed } };
    serialized = JSON.stringify(current);
  }

  return { state: current, evicted, bytes: serialized.length };
}
