import type { PGlite } from "@electric-sql/pglite";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";

/**
 * Loads ranked memory packs for rendering above the message tail.
 *
 * The loader splits durable memory into two layers along a single axis —
 * does the row's session_id match the current runner's session?
 *
 *   - Local layer: rows whose session_id equals the current session. The
 *     current session's compacted view of itself (observations + the
 *     reflection that may have replaced them). Rendered chronologically
 *     and unranked because it represents the conversation's own
 *     compaction summary; reordering it would lose the time signal.
 *
 *   - Global layer: every other session's rows, ranked by
 *     `priority * recencyDecay * kindBias`. Reflections rank higher than
 *     raw observations through `reflectionBias`. Greedy-fitted to a
 *     fixed token budget so the prompt prefix stays bounded regardless
 *     of how big the durable memory database has grown.
 *
 * The two layers are intentionally rendered with separate headings so
 * the model can tell what comes from this conversation versus what
 * comes from accumulated cross-session knowledge. The render order is
 * `system prompt -> global -> local -> message history`: the global
 * pack is the most stable prefix (rebuilt only on compaction), local
 * is medium-stability (replaced on each reflection), and the message
 * tail is the only part that grows turn over turn.
 */

const PRIORITY_WEIGHT: Record<ObservationPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface ScoreInputs {
  /** Wall-clock time at which scoring is happening. Same value across one ranking pass. */
  now: number;
  /** Half-life for the recency exponential decay. Same units as createdAt (milliseconds). */
  halfLifeMs: number;
  /** Multiplier applied when an observation is a reflection rather than a raw observation. */
  reflectionBias: number;
}

/**
 * Combined relevance score used to rank the global layer.
 *
 *   score = priorityWeight * recencyDecay * kindBias
 *
 * - priorityWeight: 3 / 2 / 1 for high / medium / low.
 * - recencyDecay: `0.5 ^ (ageMs / halfLifeMs)`. Equals 1.0 at age 0,
 *   0.5 at one half-life, ~0.0625 at four half-lives. Smooth and
 *   parameterizable; no cliffs.
 * - kindBias: `reflectionBias` for reflections, 1.0 for raw
 *   observations. Default 1.3 keeps reflections preferred at matched
 *   priority/recency without shutting raw observations out.
 *
 * Examples at the default 7d half-life and 1.3 reflection bias:
 *   - high reflection, 0d:    3 * 1.0    * 1.3 = 3.9
 *   - high observation, 0d:   3 * 1.0    * 1.0 = 3.0
 *   - medium reflection, 0d:  2 * 1.0    * 1.3 = 2.6
 *   - high reflection, 7d:    3 * 0.5    * 1.3 = 1.95
 *   - low observation, 30d:   1 * 0.0508 * 1.0 = 0.05  (effectively pruned)
 */
export function score(observation: Observation, inputs: ScoreInputs): number {
  const priorityWeight = PRIORITY_WEIGHT[observation.priority];
  const ageMs = Math.max(0, inputs.now - observation.createdAt);
  const recencyDecay = Math.pow(0.5, ageMs / inputs.halfLifeMs);
  const kindBias = observation.kind === "reflection" ? inputs.reflectionBias : 1.0;
  return priorityWeight * recencyDecay * kindBias;
}

export interface LoadGlobalPackOptions {
  /**
   * Session whose rows are excluded from the global pack. The current
   * runner's session lives in the local pack at full fidelity, so
   * counting its rows in the global ranking would double-count and
   * push out cross-session signal. Pass `undefined` to include every
   * row (e.g. for the `recall_memory` tool when the user wants
   * unrestricted search).
   */
  excludeSessionId?: string;
  /** Maximum tokens of `content` packed into the result. Defaults to 8000. */
  tokenBudget?: number;
  /** Recency half-life in milliseconds. */
  recencyHalfLifeMs: number;
  /** Reflection bias multiplier. */
  reflectionBias: number;
  /**
   * Override for `Date.now()`, used by tests so fixture data with
   * fixed `created_at` values produces deterministic scores.
   */
  now?: number;
}

/**
 * Load the highest-scoring rows from every session except the caller's,
 * up to the token budget. Returns rows ordered by descending score so
 * the renderer can preserve the ranking visually.
 *
 * Implementation note: the database query orders by `created_at DESC`
 * (cheap with the `idx_obs_kind_priority_created` index) and a generous
 * over-fetch limit; the actual ranking happens in JS so the recency
 * decay term can be applied without trying to express `0.5 ^ x` in
 * portable SQL. With a 8k-token budget and ~250-token rows this means
 * a worst case of ~32 rows packed; the over-fetch keeps the planner
 * cheap even when the budget is set higher.
 */
export async function loadGlobalPack(
  db: PGlite,
  options: LoadGlobalPackOptions,
): Promise<Observation[]> {
  const tokenBudget = options.tokenBudget ?? 8000;
  const now = options.now ?? Date.now();

  // Over-fetch by a comfortable factor so the JS-side scorer has enough
  // candidates to find the top-N regardless of priority distribution.
  // 4x the typical row count fitting in the budget keeps the SQL cheap
  // while leaving headroom for a long tail of low-priority rows.
  const overFetchLimit = Math.max(200, Math.ceil(tokenBudget / 50));

  let result: { rows: GlobalRow[] };
  if (options.excludeSessionId === undefined) {
    result = await db.query<GlobalRow>(
      `SELECT id, created_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       ORDER BY created_at DESC
       LIMIT $1`,
      [overFetchLimit],
    );
  } else {
    // NULL session_id rows (legacy, pre-sessionId tracking) are kept in
    // the global pool because they cannot match any current session.
    // Without `IS DISTINCT FROM` Postgres would treat NULL = X as NULL,
    // which filters those legacy rows out of every query.
    result = await db.query<GlobalRow>(
      `SELECT id, created_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       WHERE session_id IS DISTINCT FROM $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [options.excludeSessionId, overFetchLimit],
    );
  }

  const candidates = result.rows.map(rowToObservation);
  const scoreInputs: ScoreInputs = {
    now,
    halfLifeMs: options.recencyHalfLifeMs,
    reflectionBias: options.reflectionBias,
  };
  const ranked = candidates
    .map((observation) => ({ observation, score: score(observation, scoreInputs) }))
    .sort((a, b) => b.score - a.score);

  const packed: Observation[] = [];
  let usedTokens = 0;
  for (const entry of ranked) {
    const tokens = estimateTokens(entry.observation.content);
    if (usedTokens + tokens > tokenBudget) {
      // Skip oversize rows but keep iterating: a smaller row later in
      // the ranking may still fit, which avoids leaving the budget
      // half-empty just because one high-scoring row was a long
      // reflection.
      continue;
    }
    packed.push(entry.observation);
    usedTokens += tokens;
  }
  return packed;
}

export interface LoadLocalPackOptions {
  sessionId: string;
}

/**
 * Load every row this session produced, ordered chronologically. The
 * local pack represents the session's own compaction summary — the
 * observations and reflections that replaced earlier transcript — so
 * it is rendered whole regardless of size. Bounding the local layer
 * is the existing observer/reflector pipeline's job: their thresholds
 * keep this set from unbounded growth, and a reflection condenses it
 * back down when it gets too large.
 */
export async function loadLocalPack(
  db: PGlite,
  options: LoadLocalPackOptions,
): Promise<Observation[]> {
  const result = await db.query<GlobalRow>(
    `SELECT id, created_at, session_id, kind, observed_date, referenced_date,
            relative_date, time_of_day, priority, source_json, content, tags_json
     FROM observations
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [options.sessionId],
  );
  return result.rows.map(rowToObservation);
}

interface GlobalRow {
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

function rowToObservation(row: GlobalRow): Observation {
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

/** Rough char-to-token estimate matching the rest of the memory subsystem. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
