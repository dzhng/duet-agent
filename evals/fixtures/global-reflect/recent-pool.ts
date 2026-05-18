/**
 * Smaller, fresher real-world fixture: a recent dump of the running
 * Duet sandbox's `~/.duet/memory.db` global pool, taken via
 * `scripts/dump-memory.ts`. Eligible (non-reflection)
 * rows only, with `ageDays` pre-computed from `createdAt` at dump time.
 *
 * Sized for evals that need a realistic but inexpensive input: dozens
 * of rows / ~15k content tokens, rather than the ~91k-token
 * `FULL_SANDBOX_POOL`. Used by reflection evals that exercise the
 * normal "trim the live pool" path instead of the worst-case fold.
 *
 * Regeneration: `bun run scripts/dump-memory.ts --kind observation --pretty --out evals/fixtures/global-reflect/recent-pool.json --stats`
 * against the current sandbox and re-import the resulting JSON.
 */
import recentPool from "./recent-pool.json" with { type: "json" };
import type { Observation } from "../../../src/types/memory.js";
import type { SeedObservation } from "./sandbox-memories.js";

interface DumpedRow {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  ageDays: number;
  sessionId?: string;
  kind: Observation["kind"];
  observedDate: string;
  referencedDate?: string;
  relativeDate?: string;
  timeOfDay?: string;
  priority: Observation["priority"];
  source: unknown;
  content: string;
  tags: string[];
}

/**
 * Backfill a synthetic `cwd="..."` attribute onto every observation-
 * group wrapper. The dump was captured before the observer learned
 * to stamp cwd on the wrapper, so the raw JSON has no project anchor
 * even though we know what repo the work was done in. Adding the
 * attribute here lets the global-reflect eval exercise the new
 * "reflector reads cwd from the wrapper" path against real data.
 *
 * Regenerated dumps captured after the cwd-aware observer landed
 * will already carry the attribute and should be loaded verbatim by
 * removing this helper.
 */
const FIXTURE_CWD = "/Users/david/dev/duet-agent";

function stampCwd(content: string): string {
  return content.replace(/<observation-group([^>]*)>/g, (full, attrs: string) => {
    if (/\bcwd="/.test(attrs)) return full;
    return `<observation-group${attrs} cwd="${FIXTURE_CWD}">`;
  });
}

function toSeed(row: DumpedRow): SeedObservation {
  return {
    sessionId: row.sessionId,
    kind: row.kind,
    observedDate: row.observedDate,
    ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
    ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
    ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
    priority: row.priority,
    source: row.source as Observation["source"],
    content: stampCwd(row.content),
    tags: row.tags,
    ageDays: row.ageDays,
  };
}

/**
 * Recent eligible (non-reflection) rows pulled from the live sandbox
 * pool. ~80 rows / ~16k content tokens at dump time.
 */
export const RECENT_POOL: SeedObservation[] = (recentPool as DumpedRow[]).map(toSeed);
