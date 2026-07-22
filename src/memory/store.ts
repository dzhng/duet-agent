import type { Observation } from "../types/memory.js";
import type { StoredMemory } from "./store/store.js";

/**
 * Frozen view of memory rendered into the prompt prefix. Database layers are
 * captured at compaction events; curated file memory is captured at initial
 * load and explicit skills reload. Every layer stays immutable between its
 * refresh events so the rendered prefix remains content-deterministic across
 * turns and preserves the provider's prompt cache.
 *
 * Observations the observer writes mid-session still flow to PGlite in
 * real time; they just do not enter `contextPack` until the next
 * refresh. The model still sees them through `recall_memory` if it
 * asks.
 */
export interface ContextPack {
  /** Curated file memories pinned ahead of every database-backed layer. */
  stored: StoredMemory[];
  /** Cross-session ranked memory; rendered above the local section. */
  global: Observation[];
  /** Current session's chronological compaction summary; rendered below global. */
  local: Observation[];
}

/**
 * Holds the frozen context pack rendered above the message tail.
 *
 * This is the only memory state the runner keeps in process. Observation
 * rows, ranking, and recall live in PGlite; curated sources live as project
 * files. Holding their rendered view here instead of rereading either source
 * on every dispatch keeps the prefix byte-identical between refresh events so
 * the provider's prompt cache survives.
 */
export class MemoryContextCache {
  private contextPack: ContextPack = { stored: [], global: [], local: [] };

  /**
   * Replace the database-backed view used by the runner's context transform.
   * Called by `rebuildMemoryContextPack()` at every compaction trigger
   * (initial load, reflector completion, wire-shaping eviction
   * horizon advance) and never for ordinary observation writes. The stored
   * layer is preserved across these database-only refreshes.
   */
  setContextPack(pack: Pick<ContextPack, "global" | "local">): void {
    this.contextPack = { ...this.contextPack, ...pack };
  }

  /** Replace only the file-backed layer without disturbing database memory. */
  setStoredContextPack(stored: StoredMemory[]): void {
    this.contextPack = { ...this.contextPack, stored };
  }

  /** Current frozen pack. Returns empty arrays when memory is disabled or pre-compaction. */
  getContextPack(): ContextPack {
    return this.contextPack;
  }
}
