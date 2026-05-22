import type { PGlite } from "@electric-sql/pglite";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import { estimateTokens } from "./observational.js";

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
 *     `priority * usageDecay * kindBias`. Reflections rank higher than
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
 *
 * Ranking is pushed entirely into SQL. The full score
 * `priority * 0.5^((now - last_used_at) / h) * kindBias` factors as
 * `const(now) * priority * 2^(last_used_at / h) * kindBias`; the
 * `const(now)` term is the same for every candidate in one ranking
 * pass and so cannot affect order. Equivalently in log space,
 * `rank = ln(priority) + ln(kindBias) + last_used_at / h`. That is a
 * pure function of columns and config — Postgres does the work, the
 * `idx_obs_kind_priority_lastused` index covers the ORDER BY, and JS
 * only does the final greedy token-budget fit.
 */

const PRIORITY_WEIGHT: Record<ObservationPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

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
  /** Half-life in milliseconds applied to time since `last_used_at`. */
  recencyHalfLifeMs: number;
  /** Reflection bias multiplier applied as a `kind = 'reflection'` factor. */
  reflectionBias: number;
}

/**
 * Load the highest-ranked rows from every session except the caller's,
 * up to the token budget. Returns rows ordered by descending rank so
 * the renderer can preserve the ranking visually.
 *
 * The SQL `ORDER BY` materializes
 * `ln(priority) + ln(kindBias) + last_used_at / h`, which is monotone
 * in the full score, so the database returns rows in the exact order
 * the runtime ranking would. JS then walks the result greedily,
 * skipping rows that would overflow the token budget but continuing
 * past them — a smaller row later in the ranking may still fit, and
 * leaving the budget half-empty just because the highest-ranked row
 * is a long reflection would waste prompt space.
 */
export async function loadGlobalPack(
  db: PGlite,
  options: LoadGlobalPackOptions,
): Promise<Observation[]> {
  const tokenBudget = options.tokenBudget ?? 8000;

  // Upper bound on how many rows could ever fit: assume each row is
  // at least ~50 tokens of content. Asking the planner for more than
  // this is wasted work; asking for fewer risks the greedy-fit
  // exhausting candidates before the budget closes.
  const candidateLimit = Math.max(50, Math.ceil(tokenBudget / 50));

  const params: unknown[] = [
    PRIORITY_WEIGHT.high,
    PRIORITY_WEIGHT.medium,
    PRIORITY_WEIGHT.low,
    options.reflectionBias,
    options.recencyHalfLifeMs,
  ];
  let scopeClause = "";
  if (options.excludeSessionId !== undefined) {
    // NULL session_id rows (legacy, pre-sessionId tracking) are kept
    // in the global pool because they cannot match any current
    // session. Without `IS DISTINCT FROM` Postgres would treat
    // NULL = X as NULL, which filters those legacy rows out of every
    // query.
    scopeClause = `WHERE session_id IS DISTINCT FROM $${params.length + 1}`;
    params.push(options.excludeSessionId);
  }
  params.push(candidateLimit);
  const limitParam = params.length;

  const sql = `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       ${scopeClause}
       ORDER BY
         ln(CASE priority WHEN 'high' THEN $1::float
                          WHEN 'medium' THEN $2::float
                          ELSE $3::float END)
         + ln(CASE kind WHEN 'reflection' THEN $4::float ELSE 1.0 END)
         + last_used_at::float / $5::float
         DESC
       LIMIT $${limitParam}`;

  const result = await db.query<GlobalRow>(sql, params);
  const ranked = result.rows.map(rowToObservation);

  const packed: Observation[] = [];
  let usedTokens = 0;
  for (const observation of ranked) {
    const tokens = estimateTokens(observation.content);
    if (usedTokens + tokens > tokenBudget) {
      continue;
    }
    packed.push(observation);
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
    `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
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

function rowToObservation(row: GlobalRow): Observation {
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
