import type { PGlite } from "@electric-sql/pglite";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import type { EmbedFn } from "./embedding.js";
import type { MemorySession } from "./session.js";

/**
 * Hybrid retrieval over the durable memory database.
 *
 * Implements the gbrain / Zep / Letta pattern: vector search and
 * keyword search run in parallel, results merge via Reciprocal Rank
 * Fusion. Vector covers fuzzy paraphrases; keyword covers exact-token
 * lookups (proper nouns, IDs, code symbols) where embeddings reliably
 * miss. RRF needs no score normalization and is stable to ranking
 * tweaks on either side.
 *
 * The two paths degrade independently:
 *   - No embedding client / endpoint unavailable: vector path is
 *     skipped and the function returns keyword-only results. Logged
 *     once by the tool layer; the user still gets recall.
 *   - Empty keyword query (whitespace, punctuation): keyword path
 *     returns nothing; vector path carries the result alone.
 *
 * If both paths fail to return anything (no API key + no FTS match)
 * the function returns an empty list rather than throwing, so the
 * tool can answer "nothing matched" without an error UX.
 */

/** Default top-K each retrieval path returns before fusion. Empirically a healthy over-fetch. */
const PER_PATH_TOP_K = 30;
/**
 * RRF constant. Matches the value gbrain and the original Cormack et
 * al. RRF paper recommend. Smaller k weights top-of-list more
 * aggressively; the default trades some top-1 sharpness for stability
 * across paths with different score scales.
 */
const RRF_K = 60;

export type RecallScope = "session" | "global" | "all";

export interface RecallMemoryOptions {
  /**
   * Memory session that owns the PGlite handle and cross-process lock.
   * The recall call wraps every query in a single `withDb` so keyword,
   * vector, and hydration all run against the same open. When the lock
   * cannot be acquired, recall returns an empty result instead of
   * throwing so the tool surface degrades gracefully.
   */
  session: MemorySession;
  /**
   * Embedding callable. When omitted (or when it throws) the vector
   * path is skipped silently and recall falls back to keyword-only.
   */
  embed?: EmbedFn;
  /** The user/agent's free-text query. */
  query: string;
  /** Maximum number of fused results to return. Defaults to 8. */
  limit?: number;
  /** Restrict to current session, every other session, or both. Defaults to "all". */
  scope?: RecallScope;
  /**
   * Session id used to evaluate the `scope` filter. Required when
   * scope is "session" or "global"; ignored when scope is "all".
   */
  sessionId?: string;
}

export interface RecallMemoryResult {
  observations: Observation[];
  /** Whether the vector path actually ran. Useful for tool output to flag degraded mode. */
  vectorSearchAttempted: boolean;
  /** Whether the vector path produced any rows. False after a 401/network failure or empty index. */
  vectorSearchSucceeded: boolean;
}

export async function recallMemory(options: RecallMemoryOptions): Promise<RecallMemoryResult> {
  const limit = options.limit ?? 8;
  const scope = options.scope ?? "all";

  // session-scoped recall without a session id is a caller bug; return
  // nothing rather than degrade to an unbounded global search.
  if (scope === "session" && !options.sessionId) {
    return { observations: [], vectorSearchAttempted: false, vectorSearchSucceeded: false };
  }

  const result = await options.session.withDb(async (db) => {
    const keywordHits = await keywordSearch(db, options.query, scope, options.sessionId);

    let vectorAttempted = false;
    let vectorHits: ScoredHit[] = [];
    if (options.embed) {
      vectorAttempted = true;
      try {
        vectorHits = await vectorSearch(db, options.embed, options.query, scope, options.sessionId);
      } catch {
        // Embedding unavailable, network blip, or empty index — drop
        // back to keyword-only. Caller surfaces the degraded mode.
        vectorHits = [];
      }
    }

    const fusedIds = reciprocalRankFusion([keywordHits, vectorHits]).slice(0, limit);
    const observations = await hydrate(db, fusedIds);

    return {
      observations,
      vectorSearchAttempted: vectorAttempted,
      vectorSearchSucceeded: vectorHits.length > 0,
    };
  });
  return result ?? { observations: [], vectorSearchAttempted: false, vectorSearchSucceeded: false };
}

interface ScoredHit {
  id: string;
  rank: number;
}

async function keywordSearch(
  db: PGlite,
  query: string,
  scope: RecallScope,
  sessionId: string | undefined,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // websearch_to_tsquery accepts free-form input with quotes and OR
  // syntax, the same shape a user would type into a search box. ts_rank
  // against the GIN index gives a relevance order rather than a uniform
  // "matched" set.
  const baseSql = `SELECT id
     FROM observations
     WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)`;
  const orderSql = `
     ORDER BY ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) DESC,
              created_at DESC
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<{ id: string }>(
    db,
    baseSql,
    orderSql,
    [trimmed],
    scope,
    sessionId,
  );
  return rows.map((row, index) => ({ id: row.id, rank: index }));
}

async function vectorSearch(
  db: PGlite,
  embed: EmbedFn,
  query: string,
  scope: RecallScope,
  sessionId: string | undefined,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { embeddings } = await embed([trimmed]);
  const vector = embeddings[0];
  if (!vector) return [];

  const baseSql = `SELECT o.id
     FROM observation_embeddings e
     JOIN observations o ON o.id = e.observation_id
     WHERE TRUE`;
  const orderSql = `
     ORDER BY e.vector <=> $1::vector
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<{ id: string }>(
    db,
    baseSql,
    orderSql,
    [`[${vector.join(",")}]`],
    scope,
    sessionId,
    // Vector search uses an `o.` alias for observations so the scope
    // predicate has to follow.
    "o.",
  );
  return rows.map((row, index) => ({ id: row.id, rank: index }));
}

/**
 * Append the scope predicate (if any) to a base query and run it. The
 * base query must end with `WHERE <something>` so the predicate can
 * be tacked on with `AND`. Predicates use IS DISTINCT FROM for the
 * "global" branch so NULL-session legacy rows stay in the pool
 * (they cannot match any current session), matching the loader.
 */
async function runScopedQuery<TRow>(
  db: PGlite,
  baseSql: string,
  orderSql: string,
  baseParams: unknown[],
  scope: RecallScope,
  sessionId: string | undefined,
  columnPrefix = "",
): Promise<{ rows: TRow[] }> {
  const nextParam = baseParams.length + 1;
  if (scope === "session" && sessionId) {
    return db.query<TRow>(`${baseSql} AND ${columnPrefix}session_id = $${nextParam}${orderSql}`, [
      ...baseParams,
      sessionId,
    ]);
  }
  if (scope === "global" && sessionId) {
    return db.query<TRow>(
      `${baseSql} AND ${columnPrefix}session_id IS DISTINCT FROM $${nextParam}${orderSql}`,
      [...baseParams, sessionId],
    );
  }
  return db.query<TRow>(`${baseSql}${orderSql}`, baseParams);
}

/**
 * Reciprocal Rank Fusion. Each ranked list contributes
 * `1 / (RRF_K + rank)` to a candidate's combined score; candidates
 * that rank highly in either list rise to the top, and a single list
 * dominating mediocre rows from the other does not steamroll a row
 * that ranks well across both.
 *
 * Returns ids ordered by descending fused score. Ties (same score)
 * resolve by first appearance, which mirrors gbrain's insertion-order
 * tiebreak.
 */
export function reciprocalRankFusion(rankedLists: ScoredHit[][]): string[] {
  const scores = new Map<string, { score: number; firstSeen: number }>();
  let order = 0;
  for (const list of rankedLists) {
    for (const hit of list) {
      const contribution = 1 / (RRF_K + hit.rank);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(hit.id, { score: contribution, firstSeen: order++ });
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => {
      if (b[1].score !== a[1].score) return b[1].score - a[1].score;
      return a[1].firstSeen - b[1].firstSeen;
    })
    .map(([id]) => id);
}

async function hydrate(db: PGlite, ids: string[]): Promise<Observation[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<HydratedRow>(
    `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
            relative_date, time_of_day, priority, source_json, content, tags_json
     FROM observations
     WHERE id = ANY($1::text[])`,
    [ids],
  );
  // Database returns rows in arbitrary order; reorder to match the
  // fused ranking so callers can treat the array as the ranked
  // result list directly.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is HydratedRow => row !== undefined)
    .map(rowToObservation);
}

interface HydratedRow {
  id: string;
  created_at: number;
  last_used_at: number;
  session_id: string | null;
  kind: ObservationKind;
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: ObservationPriority;
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: HydratedRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
