import { estimateTokens } from "../observational.js";
import { mergeListings } from "./sources.js";
import { listStoreTolerant, type StoredMemory } from "./store.js";

/** Standalone ceiling for curated file memory pinned into an agent prompt. */
export const PINNED_STORE_TOKEN_BUDGET = 15_000;

export interface LoadPinnedStorePackOptions {
  /** Store directories in collision precedence order, nearest first. */
  stores: readonly string[];
  /** Independent ceiling for file-backed content; defaults to 15,000 tokens. */
  tokenBudget?: number;
}

export interface PinnedStorePack {
  /** Newest-first entries retained after collision resolution and budget fitting. */
  entries: StoredMemory[];
  /** Number of complete older entries removed to satisfy the cap. */
  dropped: number;
}

/**
 * Load a frozen, newest-first view of curated file memories.
 *
 * Malformed entries are isolated to their own file and warned about instead
 * of making agent startup fail. When the complete set exceeds the independent
 * cap, whole entries leave oldest-first; the newest entry is retained and
 * deterministically tail-truncated when it alone is too large.
 */
export async function loadPinnedStorePack(
  options: LoadPinnedStorePackOptions,
): Promise<PinnedStorePack> {
  const tokenBudget = options.tokenBudget ?? PINNED_STORE_TOKEN_BUDGET;
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error(`Pinned store token budget must be a non-negative number: ${tokenBudget}`);
  }

  const listings = await Promise.all(
    options.stores.map(async (store) => ({
      source: store,
      entries: await loadStoreEntries(store),
    })),
  );
  const entries = mergeListings(listings, []);
  let totalTokens = entries.reduce((total, entry) => total + estimateTokens(entry.content), 0);
  let dropped = 0;
  let truncated = false;

  while (entries.length > 1 && totalTokens > tokenBudget) {
    const removed = entries.pop()!;
    totalTokens -= estimateTokens(removed.content);
    dropped += 1;
  }

  if (entries.length === 1 && totalTokens > tokenBudget) {
    entries[0] = {
      ...entries[0]!,
      content: truncateToTokenBudget(entries[0]!.content, tokenBudget),
    };
    truncated = true;
  }

  if (dropped > 0 || truncated) {
    const truncation = truncated ? " and truncated the newest entry" : "";
    const formattedBudget = tokenBudget.toLocaleString("en-US");
    console.warn(
      `[duet-agent] pinned memory store context exceeded ${formattedBudget}-token cap; dropped ${dropped} older memory ${dropped === 1 ? "entry" : "entries"}${truncation}.`,
    );
  }

  return { entries, dropped };
}

async function loadStoreEntries(store: string): Promise<StoredMemory[]> {
  try {
    return await listStoreTolerant(store, warnSkippedStore);
  } catch (error) {
    warnSkippedStore(store, error);
    return [];
  }
}

function truncateToTokenBudget(content: string, tokenBudget: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, midpoint)) <= tokenBudget) low = midpoint;
    else high = midpoint - 1;
  }
  return content.slice(0, low);
}

function warnSkippedStore(path: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[duet-agent] skipped malformed memory store entry ${path}: ${reason}`);
}
