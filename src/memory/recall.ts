import type { PGlite } from "@electric-sql/pglite";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
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

/**
 * Gentle kind prior applied to the fused recall score so curated rows edge
 * out comparable matches without steamrolling relevance.
 *
 * Deliberately far smaller than the loader's `manualBias` (100): the global
 * pack uses a huge factor because it is an always-on, relevance-free ranking
 * where curated rows *should* dominate, but recall is a relevance-first
 * search. A 100x factor here would float any weakly-matching manual row to
 * the top and defeat the point of the query, so the prior is sized to act as
 * a tiebreaker among rows that already matched on keyword/vector.
 */
const RECALL_KIND_BIAS: Record<ObservationKind, number> = {
  manual: 1.5,
  note: 1.3,
  reflection: 1.25,
  observation: 1.0,
};

/** Gentle priority prior, same tiebreaker rationale as {@link RECALL_KIND_BIAS}. */
const RECALL_PRIORITY_BIAS: Record<ObservationPriority, number> = {
  high: 1.2,
  medium: 1.0,
  low: 0.9,
};

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

export interface RecallMemoryExpandedOptions extends RecallMemoryOptions {
  /**
   * When set, generate paraphrases of `query` with this model and fuse a
   * recall run per phrasing on top of the original. Broadens recall on vague
   * queries; leave undefined to run the single-query path. Callers that lack
   * a model (or want to keep latency low) simply omit it.
   */
  expansionModel?: string;
}

export interface RecallMemoryExpandedResult extends RecallMemoryResult {
  /** Whether paraphrase expansion actually contributed extra query runs. */
  expanded: boolean;
  /**
   * Final cross-run RRF fused relevance score per observation id — the same
   * score that ordered {@link RecallMemoryResult.observations}. Keyed by id so
   * callers that serialize each row (e.g. `memory recall --json`) can attach
   * `relevanceScore` without recomputing fusion. The `observations` array and
   * its ordering are unchanged; callers may ignore this field entirely.
   */
  relevanceById: Map<string, number>;
}

/**
 * The full recall pipeline shared by the `recall_memory` tool and the
 * `duet memory recall` CLI: optionally expand the query into paraphrases,
 * run {@link recallMemory} once per phrasing, and fuse the ranked result
 * lists with Reciprocal Rank Fusion so a row that scores well on any
 * phrasing rises to the top. Keeping this in one place is what makes the
 * tool and the CLI return identical rankings for the same query.
 *
 * With no `expansionModel` (or when paraphrase generation fails) this is
 * exactly a single {@link recallMemory} call, so the single-query path stays
 * the cheap default.
 */
export async function recallMemoryExpanded(
  options: RecallMemoryExpandedOptions,
): Promise<RecallMemoryExpandedResult> {
  const limit = options.limit ?? 8;

  const queries = [options.query];
  if (options.expansionModel) {
    queries.push(...(await generateQueryParaphrases(options.query, options.expansionModel)));
  }
  const expanded = queries.length > 1;

  const runs = await Promise.all(
    queries.map((query) =>
      recallMemory({
        session: options.session,
        ...(options.embed ? { embed: options.embed } : {}),
        query,
        // Over-fetch per run so the post-fusion top-K is drawn from a richer
        // candidate pool when expansion is on.
        limit: expanded ? limit * 2 : limit,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      }),
    ),
  );

  const fused = reciprocalRankFusionScored(
    runs.map((run) => run.observations.map((observation, rank) => ({ id: observation.id, rank }))),
  ).slice(0, limit);
  const byId = new Map(
    runs.flatMap((run) => run.observations).map((observation) => [observation.id, observation]),
  );
  const relevanceById = new Map<string, number>();
  const observations: Observation[] = [];
  for (const { id, score } of fused) {
    const observation = byId.get(id);
    if (!observation) continue;
    observations.push(observation);
    relevanceById.set(id, score);
  }

  return {
    observations,
    vectorSearchAttempted: runs.some((run) => run.vectorSearchAttempted),
    vectorSearchSucceeded: runs.some((run) => run.vectorSearchSucceeded),
    expanded,
    relevanceById,
  };
}

const paraphraseSchema = Type.Object({
  paraphrases: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
});

/**
 * Rewrite a recall query into up to two alternate phrasings via a cheap
 * model. Two is the sweet spot in the gbrain ablation: enough breadth to
 * catch reworded queries, few enough that latency stays low. Returns an
 * empty list on any failure so the surrounding pipeline degrades to the
 * original query alone rather than erroring.
 */
async function generateQueryParaphrases(query: string, model: string): Promise<string[]> {
  try {
    const result = await generateStructuredOutput({
      model,
      tool: {
        name: "emit_paraphrases",
        description: "Return alternate phrasings of the user's query.",
        parameters: paraphraseSchema,
      },
      systemPrompt:
        "You rewrite a memory-recall query into 2 alternative phrasings. Keep the same intent; vary terminology. Do not answer the query.",
      prompt: `Original query: ${query}`,
    });
    return result.paraphrases.slice(0, 2);
  } catch {
    return [];
  }
}

interface ScoredHit {
  id: string;
  rank: number;
  /** Row kind, used by {@link reciprocalRankFusion} to apply the recall prior. Optional so callers (and tests) may fuse on rank alone. */
  kind?: ObservationKind;
  /** Row priority, used by {@link reciprocalRankFusion} to apply the recall prior. Optional so callers may fuse on rank alone. */
  priority?: ObservationPriority;
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
  const baseSql = `SELECT id, kind, priority
     FROM observations
     WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)`;
  const orderSql = `
     ORDER BY ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) DESC,
              created_at DESC
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<HitRow>(db, baseSql, orderSql, [trimmed], scope, sessionId);
  return rows.map((row, index) => ({
    id: row.id,
    rank: index,
    kind: row.kind,
    priority: row.priority,
  }));
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

  const baseSql = `SELECT o.id, o.kind, o.priority
     FROM observation_embeddings e
     JOIN observations o ON o.id = e.observation_id
     WHERE TRUE`;
  const orderSql = `
     ORDER BY e.vector <=> $1::vector
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<HitRow>(
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
  return rows.map((row, index) => ({
    id: row.id,
    rank: index,
    kind: row.kind,
    priority: row.priority,
  }));
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
 * The fused score is then multiplied by a gentle prior derived from the
 * row's kind and priority ({@link RECALL_KIND_BIAS} / {@link
 * RECALL_PRIORITY_BIAS}) so curated and high-priority rows edge out
 * comparable matches — a tiebreaker on top of relevance, not a replacement
 * for it. Hits without kind/priority metadata get a neutral 1.0 prior, so
 * fusing on rank alone keeps the pure-RRF behavior.
 *
 * Returns ids ordered by descending biased score. Ties (same score)
 * resolve by first appearance, which mirrors gbrain's insertion-order
 * tiebreak.
 */
export function reciprocalRankFusion(rankedLists: ScoredHit[][]): string[] {
  return reciprocalRankFusionScored(rankedLists).map((entry) => entry.id);
}

/**
 * Like {@link reciprocalRankFusion}, but returns each id paired with its final
 * biased fused score (`sum(1 / (RRF_K + rank)) * kindPriorityBias`) in the same
 * descending order. Used where callers need the ranking score itself — e.g. to
 * surface `relevanceScore` per row — not just the ordered ids.
 */
export function reciprocalRankFusionScored(
  rankedLists: ScoredHit[][],
): Array<{ id: string; score: number }> {
  const scores = new Map<string, { score: number; firstSeen: number; prior: number }>();
  let order = 0;
  for (const list of rankedLists) {
    for (const hit of list) {
      const contribution = 1 / (RRF_K + hit.rank);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(hit.id, { score: contribution, firstSeen: order++, prior: recallPrior(hit) });
      }
    }
  }

  return Array.from(scores.entries())
    .map(([id, entry]) => ({ id, score: entry.score * entry.prior, firstSeen: entry.firstSeen }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.firstSeen - b.firstSeen;
    })
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Multiplicative recall prior for one hit: `kindBias * priorityBias`, each
 * defaulting to 1.0 when the corresponding metadata is absent.
 */
function recallPrior(hit: Pick<ScoredHit, "kind" | "priority">): number {
  const kindBias = hit.kind ? RECALL_KIND_BIAS[hit.kind] : 1.0;
  const priorityBias = hit.priority ? RECALL_PRIORITY_BIAS[hit.priority] : 1.0;
  return kindBias * priorityBias;
}

interface HitRow {
  id: string;
  kind: ObservationKind;
  priority: ObservationPriority;
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
