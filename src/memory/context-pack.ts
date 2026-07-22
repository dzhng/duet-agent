import type { ObservationalMemorySettings } from "../types/memory.js";
import { loadGlobalPack, loadLocalPack } from "./loader.js";
import { loadPinnedStorePack } from "./store/pack.js";
import type { MemorySession } from "./session.js";
import type { MemoryContextCache } from "./store.js";

/** Refresh only curated file memory, independently of database availability. */
export async function rebuildPinnedStoreContextPack(options: {
  stores: readonly string[];
  cache: MemoryContextCache;
}): Promise<void> {
  const pack = await loadPinnedStorePack({ stores: options.stores });
  options.cache.setStoredContextPack(pack.entries);
}

/**
 * Compaction trigger: rebuild the frozen memory pack rendered above
 * the message tail, then store it on the runner's MemoryContextCache.
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
  session: MemorySession | undefined;
  cache: MemoryContextCache;
  settings: ObservationalMemorySettings;
  sessionId?: string;
}): Promise<void> {
  if (!options.session) return;

  // One withDb pins the open across the global+local pack queries so the
  // cross-process lock is held just once for the rebuild, then released
  // a couple seconds later when the idle-close timer fires.
  await options.session.withDb(async (db) => {
    // Local layer skipped when the runner has no session id (one-shot
    // tools, tests). Global layer always runs because the loader's
    // `excludeSessionId` is optional and meaningful as undefined.
    const [globalPack, localPack] = await Promise.all([
      loadGlobalPack(db, {
        ...(options.sessionId !== undefined ? { excludeSessionId: options.sessionId } : {}),
        tokenBudget: options.settings.globalContextTokenBudget,
        recencyHalfLifeMs: options.settings.recencyHalfLifeMs,
        reflectionBias: options.settings.reflectionBias,
        manualBias: options.settings.manualBias,
        noteBias: options.settings.noteBias,
      }),
      options.sessionId !== undefined
        ? loadLocalPack(db, { sessionId: options.sessionId })
        : Promise.resolve([]),
    ]);

    options.cache.setContextPack({ global: globalPack, local: localPack });
  });
}
