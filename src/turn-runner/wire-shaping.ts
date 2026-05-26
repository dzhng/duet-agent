import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHARS_PER_TOKEN } from "../memory/observational.js";
import type { WireGuardHorizon } from "../types/protocol.js";

/**
 * Byte-budget safety net for the dispatched message list. The token-budget
 * trigger in `createObservationalContextTransform` is the primary gate for
 * normal text-and-tool sessions, but image attachments break that gate: a
 * single inline image can carry hundreds of KB of base64 while the
 * provider's per-image token charge is bounded (and unpredictable across
 * providers and resolutions). Without a byte gate, a few large screenshots
 * could push the serialized request well past any sane limit before the
 * token estimate catches up.
 *
 * 15 MB is well above typical text-only contexts but still bounded; it
 * caps how much image payload a single dispatched body can carry before
 * compaction kicks in, regardless of how cheap the provider claims the
 * image tokens are.
 */
export const WIRE_BYTE_TRIGGER = 15 * 1024 * 1024;

/**
 * When eviction fires, drop oldest messages until the wire payload reaches
 * this target — well below the trigger — so the next several turns can
 * grow back up before tripping eviction again. One large block-evict per
 * crossing is far cheaper for prompt caching than incrementally trimming
 * on every turn (each advance invalidates the cached prefix once, so
 * fewer advances = fewer invalidations).
 */
export const WIRE_BYTE_TARGET = Math.floor(WIRE_BYTE_TRIGGER * 0.8);

/**
 * Conservative cross-provider charge for one inline image on the wire.
 * Claude vision tops out near 1,568 tokens per image and OpenAI high-detail
 * images grow by 512px tiles, so 1,600 is a rounded estimate that creates
 * real context pressure without inflating with the base64 payload size.
 *
 * The base64 byte length of an image is meaningless as a token signal:
 * `ceil(bytes/4)` over a 2 MB inline image scores ~500K "tokens" while the
 * provider only bills a few thousand. That mismatch tripped the
 * `messageTokens` eviction gate on image-heavy turns and evicted earlier
 * user messages from the wire (see the thread-context-loss eval). Image
 * payload size is bounded separately by {@link WIRE_BYTE_TRIGGER}.
 */
export const IMAGE_WIRE_TOKEN_ESTIMATE = 1_600;

/**
 * Eviction will not trim below this many recent messages. The latest user
 * message is the actor's current prompt and must always survive; any
 * deeper budget shortfall is absorbed by the durable observation memory
 * that the memory transform prepends to the dispatched message list.
 */
const MIN_HISTORY_TAIL = 1;

/**
 * Fresh-runner default. Persistence round-trips `WireGuardHorizon` through
 * `TurnState.wireGuardHorizon`, so resumed sessions hydrate over this
 * default in place via `Object.assign` to preserve the reference identity
 * held by the observational context transform.
 */
export function createInitialHorizon(): WireGuardHorizon {
  return { evictionHorizon: 0 };
}

interface ImageBlock {
  type: "image";
  data: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function messageTimestamp(msg: AgentMessage): number {
  return (msg as { timestamp?: number }).timestamp ?? 0;
}

/**
 * Bytes contributed by one message to the serialized wire payload. Image
 * blocks count base64 length, text blocks count UTF-16 length, and every
 * other structured block (thinking with its `thinkingSignature`, toolCall,
 * toolResult details) falls back to a JSON serialization estimate. The
 * JSON path is what actually gets sent on the wire for those blocks, so
 * counting `JSON.stringify(block).length` is both the simplest and the
 * most accurate option for them. Approximate but tracks request body size
 * closely enough for budget gating and the context bar.
 */
function calculateMessageBytes(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isImageBlock(block)) total += block.data.length;
    else if (isTextBlock(block)) total += block.text.length;
    else if (block && typeof block === "object") {
      try {
        total += JSON.stringify(block).length;
      } catch {
        total += 256;
      }
    }
  }
  return total;
}

export function calculateWireBytes(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += calculateMessageBytes(msg);
  return total;
}

/**
 * Token-side companion to {@link calculateWireBytes}. Text and structured
 * blocks use the same `ceil(chars / CHARS_PER_TOKEN)` heuristic the memory
 * pipeline uses elsewhere, but image blocks contribute a fixed
 * {@link IMAGE_WIRE_TOKEN_ESTIMATE} regardless of base64 size — the
 * provider's per-image charge is bounded and unrelated to payload bytes.
 * This is the value the eviction gate and the context-window usage bar
 * should compare against `messageTokens`; the byte-size safety net is
 * handled separately by {@link WIRE_BYTE_TRIGGER}.
 */
function calculateMessageTokens(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isImageBlock(block)) total += IMAGE_WIRE_TOKEN_ESTIMATE;
    else if (isTextBlock(block)) total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
    else if (block && typeof block === "object") {
      try {
        total += Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
      } catch {
        total += 64;
      }
    }
  }
  return total;
}

export function calculateWireTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += calculateMessageTokens(msg);
  return total;
}

/**
 * Drop messages whose timestamp is at or before the eviction horizon, then
 * skip any orphan tool results or assistant messages at the new head so
 * the provider API receives a list that starts with a `user` turn.
 */
export function applyEvictionHorizon(messages: AgentMessage[], horizon: number): AgentMessage[] {
  if (horizon <= 0) return messages;
  let firstKept = 0;
  while (firstKept < messages.length && messageTimestamp(messages[firstKept]!) <= horizon) {
    firstKept += 1;
  }
  while (firstKept < messages.length && messages[firstKept]!.role !== "user") {
    firstKept += 1;
  }
  if (firstKept === 0) return messages;
  return messages.slice(firstKept);
}

/**
 * Walk oldest-first, advance the horizon past each message in turn, and
 * stop when the caller-supplied predicate reports both budgets satisfied.
 * Will not trim below {@link MIN_HISTORY_TAIL} recent messages. Returns
 * a horizon at least as advanced as `current` (advance-only).
 *
 * Callers that need to preserve the evictable span into durable memory
 * must do so before invoking this function — advancing the horizon
 * here will drop messages whose content is only readable through the
 * memory store, so the runner's `ensureMemoryCoverageForCompaction`
 * runs first on every path that reaches this walk.
 */
export function findEvictionHorizon(
  messages: AgentMessage[],
  current: number,
  satisfiesBudget: (candidate: AgentMessage[]) => boolean,
): number {
  if (messages.length <= MIN_HISTORY_TAIL) return current;
  const evictable = messages.slice(0, messages.length - MIN_HISTORY_TAIL);
  let horizon = current;
  for (const msg of evictable) {
    horizon = Math.max(horizon, messageTimestamp(msg));
    if (satisfiesBudget(applyEvictionHorizon(messages, horizon))) break;
  }
  return horizon;
}
