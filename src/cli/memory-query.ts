import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import { printMemoryHelp } from "./help.js";
import { type MemoryQueryFilters, scoreObservation, withMemoryDb } from "./memory-db.js";
import { fail, resolveUserPath } from "./shared.js";

interface MemoryQueryIO {
  stdout: NodeJS.WritableStream;
}

type ScoredObservation = Observation & { score: number };

/**
 * Build a runtime filter list that must enumerate *every* member of `T`.
 * A bare `satisfies readonly T[]` only checks each element is a valid `T`; it
 * silently tolerates a missing member — that gap is how `note` dropped out of
 * the kind filter and made `--type note` get rejected. This helper fails to
 * compile when the array omits any union member, so adding a new
 * `ObservationKind`/priority/source forces the matching filter to grow with it.
 */
function exhaustiveList<T extends string>() {
  return <L extends readonly T[]>(list: [T] extends [L[number]] ? L : never): L => list;
}

const KINDS = exhaustiveList<ObservationKind>()(["observation", "reflection", "note", "manual"]);
const PRIORITIES = exhaustiveList<ObservationPriority>()(["high", "medium", "low"]);
type SourceKind = Observation["source"]["kind"];
const SOURCES = exhaustiveList<SourceKind>()(["user", "agent", "system"]);

export interface MemoryQueryOptions {
  dbPath: string;
  json: boolean;
  filters: MemoryQueryFilters;
  waitBudgetMs?: number;
  /**
   * True when the invocation requested a non-TUI query — i.e. it passed
   * `--json` or any filter flag. Bare `duet memory` (only `--db`/`--wait`)
   * leaves this false and opens the interactive TUI instead.
   */
  queryMode: boolean;
}

/** Parse UTC date filters; date-only bounds cover the whole day. */
function parseDateBound(raw: string, flag: string, edge: "start" | "end"): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const iso = `${raw}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) fail(`Invalid ${flag} date: ${raw}`);
    // Reject impossible calendar dates (e.g. 2026-02-31) that JS silently
    // normalizes into a different day rather than returning NaN — otherwise a
    // typo slides the createdAt window and the wrong rows get exported.
    if (new Date(ms).toISOString().slice(0, 10) !== raw) {
      fail(`Invalid ${flag} date: ${raw} is not a real calendar date`);
    }
    return ms;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}Z`);
    if (Number.isNaN(ms)) fail(`Invalid ${flag} datetime: ${raw}`);
    // Same round-trip guard for the datetime form (e.g. 2026-02-31T00:00:00).
    if (new Date(ms).toISOString().slice(0, 19) !== raw) {
      fail(`Invalid ${flag} datetime: ${raw} is not a real calendar datetime`);
    }
    return ms;
  }
  fail(`Invalid ${flag} value: ${raw} (expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)`);
}

function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flag: string,
): T {
  if (!raw || raw.startsWith("-")) fail(`Missing value for ${flag}`);
  if (!(allowed as readonly string[]).includes(raw)) {
    fail(`Invalid ${flag} value: ${raw} (expected one of ${allowed.join(", ")})`);
  }
  return raw as T;
}

/**
 * Parse the shared `duet memory` argument set. The same flags drive both the
 * interactive TUI (bare invocation) and the scriptable query (any filter or
 * `--json`); `queryMode` records which path the caller asked for. Returns
 * `undefined` when `--help` was handled.
 */
export function parseMemoryArgs(args: string[]): MemoryQueryOptions | undefined {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let json = false;
  let waitBudgetMs: number | undefined;
  let hasFilter = false;
  const filters: MemoryQueryFilters = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      // `--type` and `--kind` are aliases for the same `Observation.kind` axis.
      case "--type":
      case "--kind":
        filters.kind = parseEnum(args[++i], KINDS, arg);
        hasFilter = true;
        break;
      case "--priority":
        filters.priority = parseEnum(args[++i], PRIORITIES, arg);
        hasFilter = true;
        break;
      case "--source":
        filters.source = parseEnum(args[++i], SOURCES, arg);
        hasFilter = true;
        break;
      case "--from": {
        const raw = args[++i];
        if (!raw || raw.startsWith("-")) fail(`Missing value for ${arg}`);
        filters.fromMs = parseDateBound(raw, arg, "start");
        hasFilter = true;
        break;
      }
      case "--to": {
        const raw = args[++i];
        if (!raw || raw.startsWith("-")) fail(`Missing value for ${arg}`);
        filters.toMs = parseDateBound(raw, arg, "end");
        hasFilter = true;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--wait": {
        const raw = args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          fail(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = seconds * 1000;
        break;
      }
      case "--help":
      case "-h":
        printMemoryHelp();
        return undefined;
      default:
        fail(`Unknown memory option: ${arg}`);
    }
  }

  if (filters.fromMs !== undefined && filters.toMs !== undefined && filters.fromMs > filters.toMs) {
    fail("--from must not be after --to");
  }

  return { dbPath, json, filters, waitBudgetMs, queryMode: json || hasFilter };
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function formatMemoryTable(observations: ScoredObservation[]): string {
  if (observations.length === 0) {
    return "No memories matched. Adjust the filters or run `duet memory --help`.";
  }
  const rows = observations.map((o) => ({
    created: new Date(o.createdAt).toISOString().slice(0, 10),
    kind: o.kind,
    priority: o.priority,
    source: o.source.kind,
    score: o.score.toFixed(2),
    content: truncate(o.content, 60),
    id: o.id,
  }));
  const headers = {
    created: "CREATED",
    kind: "KIND",
    priority: "PRIORITY",
    source: "SOURCE",
    score: "SCORE",
    content: "CONTENT",
    id: "MEMORY ID",
  };
  const width = (key: keyof typeof headers, cap: number) =>
    Math.min(cap, Math.max(headers[key].length, ...rows.map((row) => row[key].length)));
  const w = {
    created: width("created", 10),
    kind: width("kind", 11),
    priority: width("priority", 8),
    source: width("source", 6),
    score: width("score", 8),
    content: width("content", 60),
    id: width("id", 20),
  };
  const line = (cells: typeof headers) =>
    [
      cells.created.padEnd(w.created),
      cells.kind.padEnd(w.kind),
      cells.priority.padEnd(w.priority),
      cells.source.padEnd(w.source),
      cells.score.padStart(w.score),
      truncate(cells.content, w.content).padEnd(w.content),
      cells.id,
    ].join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * Run the non-TUI query path of `duet memory`: fetch the filtered rows,
 * compute each row's global-pack score, and print JSON or an aligned table.
 */
export async function runMemoryQuery(
  options: MemoryQueryOptions,
  io: MemoryQueryIO = { stdout: process.stdout },
): Promise<void> {
  const observations = await withMemoryDb(
    options.dbPath,
    (db) => db.queryObservations(options.filters),
    { waitBudgetMs: options.waitBudgetMs },
  );
  // Score with a single `now` so every row's value is comparable.
  const now = Date.now();
  const scored: ScoredObservation[] = observations.map((o) => ({
    ...o,
    score: scoreObservation(o, now),
  }));

  io.stdout.write(
    options.json ? `${JSON.stringify(scored, null, 2)}\n` : `${formatMemoryTable(scored)}\n`,
  );
}
