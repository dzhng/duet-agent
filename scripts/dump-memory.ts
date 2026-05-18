/**
 * Dump observations from a `memory.db` PGlite store into JSON for
 * debugging or fixture creation. Default source is the running user's
 * `~/.duet/memory.db`; default destination is stdout.
 *
 * This is the canonical reproduction step when the agent's observational
 * memory misbehaves: dump the live store, then feed the JSON into an
 * eval (`evals/fixtures/global-reflect/seed.ts`) so the bug becomes
 * deterministic without touching production memory.
 *
 * Usage:
 *   bun run scripts/dump-memory.ts [options]
 *
 * Options:
 *   --db <path>            Source PGlite path (default: ~/.duet/memory.db)
 *   --out <path>           Write to file (default: stdout)
 *   --kind <k>             Filter by row kind: observation | reflection | all (default: all)
 *   --since <iso|days>     Only rows created on/after this date. Accepts
 *                          ISO-8601 (`2026-05-01T00:00:00Z`), `YYYY-MM-DD`,
 *                          or a relative form like `7d` / `48h` meaning
 *                          "newer than that long ago".
 *   --until <iso|days>     Only rows created on/before this date. Same forms.
 *   --session <id>         Only rows for a specific session id. Repeatable;
 *                          pass `__global_reflection__` for global-prune rows.
 *   --priority <p>         Filter by priority: high | medium | low. Repeatable.
 *   --tag <name>           Only rows tagged with <name>. Repeatable; AND across flags.
 *   --limit <n>            Cap the number of rows written (newest first).
 *   --pretty               Pretty-print JSON (default: compact).
 *   --stats                Print a one-line summary to stderr (count, tokens, age range).
 *   -h, --help             Show this help.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import { readAllObservations } from "../src/memory/storage.js";
import type { Observation } from "../src/types/memory.js";

interface Options {
  db: string;
  out?: string;
  kind: "observation" | "reflection" | "all";
  since?: number;
  until?: number;
  sessions: Set<string>;
  priorities: Set<string>;
  tags: string[];
  limit?: number;
  pretty: boolean;
  stats: boolean;
}

const DAY_MS = 86_400_000;

function parseTime(raw: string): number {
  const relative = raw.match(/^(\d+(?:\.\d+)?)(d|h|m)$/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = unit === "d" ? n * DAY_MS : unit === "h" ? n * 3_600_000 : n * 60_000;
    return Date.now() - ms;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) fail(`Invalid time: ${raw}`);
  return parsed;
}

function fail(message: string): never {
  process.stderr.write(`dump-memory: ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`Usage: bun run scripts/dump-memory.ts [options]

Options:
  --db <path>           Source PGlite path (default: ~/.duet/memory.db)
  --out <path>          Write to file (default: stdout)
  --kind <k>            observation | reflection | all (default: all)
  --since <iso|Nd|Nh>   Only rows created on/after this time
  --until <iso|Nd|Nh>   Only rows created on/before this time
  --session <id>        Filter by session id (repeatable)
  --priority <p>        high | medium | low (repeatable)
  --tag <name>          Filter by tag (repeatable, AND)
  --limit <n>           Cap rows written (newest first)
  --pretty              Pretty-print JSON
  --stats               Print summary to stderr
  -h, --help            Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    db: join(homedir(), ".duet", "memory.db"),
    kind: "all",
    sessions: new Set(),
    priorities: new Set(),
    tags: [],
    pretty: false,
    stats: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      case "--db":
        opts.db = resolve(next());
        break;
      case "--out":
        opts.out = resolve(next());
        break;
      case "--kind": {
        const v = next();
        if (v !== "observation" && v !== "reflection" && v !== "all") {
          fail(`--kind must be observation | reflection | all (got ${v})`);
        }
        opts.kind = v;
        break;
      }
      case "--since":
        opts.since = parseTime(next());
        break;
      case "--until":
        opts.until = parseTime(next());
        break;
      case "--session":
        opts.sessions.add(next());
        break;
      case "--priority": {
        const v = next();
        if (v !== "high" && v !== "medium" && v !== "low") {
          fail(`--priority must be high | medium | low (got ${v})`);
        }
        opts.priorities.add(v);
        break;
      }
      case "--tag":
        opts.tags.push(next());
        break;
      case "--limit": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) fail(`--limit must be a positive number`);
        opts.limit = Math.floor(n);
        break;
      }
      case "--pretty":
        opts.pretty = true;
        break;
      case "--stats":
        opts.stats = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function matches(row: Observation, opts: Options): boolean {
  if (opts.kind !== "all" && row.kind !== opts.kind) return false;
  if (opts.since !== undefined && row.createdAt < opts.since) return false;
  if (opts.until !== undefined && row.createdAt > opts.until) return false;
  if (
    opts.sessions.size > 0 &&
    (row.sessionId === undefined || !opts.sessions.has(row.sessionId))
  ) {
    return false;
  }
  if (opts.priorities.size > 0 && !opts.priorities.has(row.priority)) return false;
  for (const tag of opts.tags) {
    if (!row.tags.includes(tag)) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const session = new MemorySession({
    path: opts.db,
    openOptions: { init: async (db) => runMigrations(db) },
    lockWaitBudgetMs: 60_000,
    idleCloseMs: 1_000,
  });

  try {
    const snapshot = await readAllObservations(session);
    let rows = snapshot.observations.filter((row) => matches(row, opts));
    // Newest first so --limit keeps the freshest slice.
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);

    const now = Date.now();
    const dumped = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ageDays: (now - row.createdAt) / DAY_MS,
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      kind: row.kind,
      observedDate: row.observedDate,
      ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
      ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
      ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
      priority: row.priority,
      source: row.source,
      content: row.content,
      tags: row.tags,
    }));

    const json = opts.pretty
      ? `${JSON.stringify(dumped, null, 2)}\n`
      : `${JSON.stringify(dumped)}\n`;
    if (opts.out) {
      writeFileSync(opts.out, json);
    } else {
      process.stdout.write(json);
    }

    if (opts.stats) {
      const chars = dumped.reduce((sum, r) => sum + r.content.length, 0);
      const ages = dumped.map((r) => r.ageDays);
      const youngest = ages.length > 0 ? Math.min(...ages).toFixed(2) : "n/a";
      const oldest = ages.length > 0 ? Math.max(...ages).toFixed(2) : "n/a";
      process.stderr.write(
        `dump-memory: ${dumped.length} row(s) (${snapshot.observations.length} total), ` +
          `~${Math.round(chars / 4)} content tokens, age ${youngest}d–${oldest}d\n`,
      );
    }
  } finally {
    await session.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
