/**
 * Realistic fixture: a full dump of the running Duet sandbox's
 * `~/.duet/memory.db` global pool, mass-redacted for PII (customer
 * emails, payment-card last-4, third-party names, contracted-influencer
 * names) but otherwise preserved verbatim. 284 rows / ~91k tokens of
 * actual production observational memory — repeated decisions,
 * supersession chains, in-flight bug threads, completion markers,
 * cron noise, and durable user-identity facts all interleaved the way
 * the reflector will see them in the wild.
 *
 * Used as the canonical input for the `duet memory reflect` evals.
 * Smaller curated slices are derived by filtering the dump, so every
 * eval is grounded in real production content rather than synthetic
 * test data.
 *
 * Regeneration: run `bun -e` against a sandbox memory db, dump to
 * JSON, then re-apply `scripts/redact-sandbox-memories.ts` (see PR
 * description for the original redactor script). The redactor must
 * keep:
 *   - team first names (David, Walter, Ali, Ani, Sawyer, Yuli)
 *   - public competitor names (Lovable, Cursor, Codex, Replit, etc.)
 *   - public Duet identifiers (PR numbers, branch names, paths)
 * and scrub:
 *   - any external email address
 *   - any non-team person name carrying customer context
 *   - payment-card identifiers (last-4, expiry)
 */
import dumpJson from "./sandbox-memories.json" with { type: "json" };
import type { Observation } from "../../../src/types/memory.js";

export type SeedObservation = Omit<Observation, "id" | "createdAt" | "lastUsedAt"> & {
  /** Days before "now" the row was originally observed; used to seed created_at. */
  ageDays: number;
};

interface DumpedRow {
  id: string;
  createdAt: number;
  lastUsedAt: number;
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

const NOW = Date.now();

function toSeed(row: DumpedRow): SeedObservation {
  const ageMs = Math.max(0, NOW - row.createdAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return {
    sessionId: row.sessionId,
    kind: row.kind,
    observedDate: row.observedDate,
    ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
    ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
    ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
    priority: row.priority,
    source: row.source as Observation["source"],
    content: row.content,
    tags: row.tags,
    ageDays,
  };
}

/**
 * Full sandbox dump as seed observations. 284 rows / ~91k tokens.
 * This is the canonical realistic input the reflector is asked to
 * condense down to a single row.
 */
export const FULL_SANDBOX_POOL: SeedObservation[] = (dumpJson as DumpedRow[]).map(toSeed);

function bySubstring(needle: string): SeedObservation[] {
  return FULL_SANDBOX_POOL.filter((seed) => seed.content.includes(needle));
}

function byAny(needles: string[]): SeedObservation[] {
  return FULL_SANDBOX_POOL.filter((seed) => needles.some((n) => seed.content.includes(n)));
}

/**
 * Derived slices used by the focused evals. Each one is just a filter
 * of the real dump so the fixtures stay in lockstep with what the
 * reflector actually sees in production.
 */
export const VELGRESS_SLICE = bySubstring("Velgress");
export const IOS_SAFE_AREA_SLICE = byAny(["#1335", "bottomInset", "safe area"]);
export const USE_CASES_HERO_SLICE = bySubstring("use-cases");
export const VIEW_TRANSITIONS_SLICE = byAny([
  "view transition",
  "View Transition",
  "#1336",
  "#1341",
]);
export const PWA_NATIVE_SLICE = byAny(["PWA", "#1340", "service worker", "share_target"]);
/**
 * Three durable strategic decisions from the real dump:
 *   - Web Push intentionally deferred (a NEGATIVE decision — chose not
 *     to ship something, with explicit rationale).
 *   - Bottom-tab crossfade removed so peer-tab nav stays plain while
 *     drill-ins animate (an architectural rule about motion scope).
 *   - `/use-cases` nav bundle split from the long-form persona spec
 *     into a dedicated lightweight nav source (a separation-of-data
 *     decision driven by review feedback).
 *
 * A future agent that loses any of these will relitigate the call.
 * The slice filters the real dump for rows mentioning each decision.
 */
export const STRATEGIC_DECISION_SLICE = byAny([
  "Web Push",
  "crossfade from bottom",
  "nav bundle",
  "nav-bundle",
]);
