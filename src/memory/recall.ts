import type { PGlite } from "@electric-sql/pglite";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import type { EmbedFn } from "./embedding.js";

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
  db: PGlite;
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
  const filterClause = buildScopeFilter(scope, options.sessionId);

  const keywordHits = await keywordSearch(options.db, options.query, filterClause);

  let vectorAttempted = false;
  let vectorHits: ScoredHit[] = [];
  if (options.embed) {
    vectorAttempted = true;
    try {
      vectorHits = await vectorSearch(options.db, options.embed, options.query, filterClause);
    } catch {
      // Embedding unavailable, network blip, or empty index — drop
      // back to keyword-only. Caller surfaces the degraded mode.
      vectorHits = [];
    }
  }

  const fusedIds = reciprocalRankFusion([keywordHits, vectorHits]).slice(0, limit);
  const observations = await hydrate(options.db, fusedIds);

  return {
    observations,
    vectorSearchAttempted: vectorAttempted,
    vectorSearchSucceeded: vectorHits.length > 0,
  };
}

interface ScoredHit {
  id: string;
  rank: number;
}

interface FilterClause {
  where: string;
  params: unknown[];
}

function buildScopeFilter(scope: RecallScope, sessionId: string | undefined): FilterClause {
  switch (scope) {
    case "session":
      if (!sessionId) {
        // Asking for session-scoped recall without a session is a
        // caller bug, not a query that "matched nothing". Empty
        // filter is safer than running an unbounded global search.
        return { where: "FALSE", params: [] };
      }
      return { where: "session_id = $$", params: [sessionId] };
    case "global":
      if (!sessionId) {
        return { where: "TRUE", params: [] };
      }
      // IS DISTINCT FROM keeps NULL-session legacy rows in the pool
      // (they cannot match any current session), matching the loader.
      return { where: "session_id IS DISTINCT FROM $$", params: [sessionId] };
    case "all":
      return { where: "TRUE", params: [] };
  }
}

/**
 * Materializes a filter clause into a positional-argument SQL fragment
 * starting at `$startIndex`. The recall queries place the filter near
 * the front of the WHERE so its parameters always come first, which
 * keeps the substitution math local and easy to audit.
 */
function materializeFilter(filter: FilterClause, startIndex: number): string {
  let nextParam = startIndex;
  return filter.where.replace(/\$\$/g, () => `$${nextParam++}`);
}

async function keywordSearch(
  db: PGlite,
  query: string,
  filter: FilterClause,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // websearch_to_tsquery accepts free-form input with quotes and OR
  // syntax, the same shape a user would type into a search box. Using
  // ts_rank against the GIN index gives us a relevance order rather
  // than a uniform "matched" set.
  const filterSql = materializeFilter(filter, 2);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id
     FROM observations
     WHERE (${filterSql})
       AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)
     ORDER BY ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) DESC,
              created_at DESC
     LIMIT ${PER_PATH_TOP_K}`,
    [trimmed, ...filter.params],
  );

  return rows.map((row, index) => ({ id: row.id, rank: index }));
}

async function vectorSearch(
  db: PGlite,
  embed: EmbedFn,
  query: string,
  filter: FilterClause,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [vector] = await embed([trimmed]);
  if (!vector) return [];

  const filterSql = materializeFilter(filter, 2);
  const { rows } = await db.query<{ id: string }>(
    `SELECT o.id
     FROM observation_embeddings e
     JOIN observations o ON o.id = e.observation_id
     WHERE (${filterSql})
     ORDER BY e.vector <=> $1::vector
     LIMIT ${PER_PATH_TOP_K}`,
    [`[${vector.join(",")}]`, ...filter.params],
  );

  return rows.map((row, index) => ({ id: row.id, rank: index }));
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
    `SELECT id, created_at, session_id, kind, observed_date, referenced_date,
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
