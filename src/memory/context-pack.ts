import type { PGlite } from "@electric-sql/pglite";
import type { ObservationalMemorySettings } from "../types/memory.js";
import { loadGlobalPack, loadLocalPack } from "./loader.js";
import type { MemoryStore } from "./store.js";

/**
 * Compaction trigger: rebuild the frozen memory pack rendered above
 * the message tail, then store it on the runner's MemoryStore.
 *
 * Three events trigger a refresh and exactly three:
 *   1. `loadStoredMemory()` finishes — initial seed.
 *   2. The reflector replaces observations — condensed view changed.
 *   3. The wire-shaping eviction horizon advances — prompt cache is
 *      already invalidating, so piggyback the refresh for free.
 *
 * Any other path (observer appending a row mid-turn, recall_memory
 * tool returning rows) deliberately does NOT refresh: the prefix stays
 * stable so the provider's prompt cache survives.
 *
 * Failure here is non-fatal — a missing database, a planner glitch,
 * or a corrupted index just leaves the previous pack in place. The
 * runner logs and continues; the user's turn is never blocked behind
 * memory bookkeeping.
 */
export async function rebuildMemoryContextPack(options: {
  db: PGlite | undefined;
  store: MemoryStore;
  settings: ObservationalMemorySettings;
  sessionId?: string;
}): Promise<void> {
  if (!options.db) return;

  // Local layer skipped when the runner has no session id (one-shot
  // tools, tests). Global layer always runs because the loader's
  // `excludeSessionId` is optional and meaningful as undefined.
  const [globalPack, localPack] = await Promise.all([
    loadGlobalPack(options.db, {
      ...(options.sessionId !== undefined ? { excludeSessionId: options.sessionId } : {}),
      tokenBudget: options.settings.globalContextTokenBudget,
      recencyHalfLifeMs: options.settings.recencyHalfLifeMs,
      reflectionBias: options.settings.reflectionBias,
    }),
    options.sessionId !== undefined
      ? loadLocalPack(options.db, { sessionId: options.sessionId })
      : Promise.resolve([]),
  ]);

  options.store.setContextPack({ global: globalPack, local: localPack });
}
