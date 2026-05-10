import type { Observation } from "../types/memory.js";

/**
 * Frozen view of memory rendered into the prompt prefix. Captured at
 * compaction events (initial load, reflector completion, wire-shaping
 * eviction) and held immutable between events so the rendered prefix
 * stays content-deterministic across turns. The provider's prompt
 * cache survives unchanged until the next compaction event, at which
 * point exactly one cache invalidation is paid — not one per turn.
 *
 * Observations the observer writes mid-session still flow to PGlite in
 * real time; they just do not enter `contextPack` until the next
 * refresh. The model still sees them through `recall_memory` if it
 * asks.
 */
export interface ContextPack {
  /** Cross-session ranked memory; rendered above the local section. */
  global: Observation[];
  /** Current session's chronological compaction summary; rendered below global. */
  local: Observation[];
}

/**
 * Holds the frozen context pack rendered above the message tail.
 *
 * This is the only piece of memory state the runner keeps in process —
 * everything else (observation rows, ranking, recall) lives in PGlite
 * and is read on demand. Holding the pack here, rather than
 * recomputing inside the transform on every dispatch, is what lets
 * the rendered prefix stay byte-identical between compaction events
 * so the provider's prompt cache survives.
 */
export class MemoryContextCache {
  private contextPack: ContextPack = { global: [], local: [] };

  /**
   * Replace the frozen view used by the runner's context transform.
   * Called by `rebuildMemoryContextPack()` at every compaction trigger
   * (initial load, reflector completion, wire-shaping eviction
   * horizon advance) and never anywhere else — that constraint is
   * what makes the rendered prefix cache-stable.
   */
  setContextPack(pack: ContextPack): void {
    this.contextPack = pack;
  }

  /** Current frozen pack. Returns empty arrays when memory is disabled or pre-compaction. */
  getContextPack(): ContextPack {
    return this.contextPack;
  }
}
