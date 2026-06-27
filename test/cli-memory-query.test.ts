import { describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb, scoreObservation } from "../src/cli/memory-db.js";
import { formatMemoryTable, parseMemoryArgs, runMemoryQuery } from "../src/cli/memory-query.js";
import type { Observation, ObservationSource } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 5, 26);

interface FixtureInput {
  id: string;
  createdAt: number;
  kind?: Observation["kind"];
  priority?: Observation["priority"];
  source?: ObservationSource;
  content?: string;
}

async function withDb(fn: (db: MemoryDb, dbPath: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-query-"));
  const dbPath = join(tempDir, "memory.db");
  const db = await MemoryDb.open(dbPath);
  try {
    await fn(db, dbPath);
  } finally {
    await db.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seed(db: MemoryDb, fixtures: FixtureInput[]): Promise<void> {
  const pg = (db as unknown as { db: import("@electric-sql/pglite").PGlite }).db;
  for (const f of fixtures) {
    await pg.query(
      `INSERT INTO observations (
        id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
        time_of_day, priority, source_json, content, tags_json
      ) VALUES ($1, $2, $3, NULL, $4, $5, NULL, NULL, NULL, $6, $7, $8, '[]')`,
      [
        f.id,
        f.createdAt,
        f.createdAt,
        f.kind ?? "observation",
        new Date(f.createdAt).toISOString().slice(0, 10),
        f.priority ?? "medium",
        JSON.stringify(f.source ?? { kind: "system" }),
        f.content ?? `content for ${f.id}`,
      ],
    );
  }
}

const SAMPLE: FixtureInput[] = [
  {
    id: "a",
    createdAt: BASE - 5 * DAY_MS,
    kind: "observation",
    priority: "low",
    source: { kind: "user" },
  },
  {
    id: "b",
    createdAt: BASE - 2 * DAY_MS,
    kind: "reflection",
    priority: "high",
    source: { kind: "agent" },
  },
  {
    id: "c",
    createdAt: BASE - 1 * DAY_MS,
    kind: "manual",
    priority: "high",
    source: { kind: "system" },
  },
  {
    id: "d",
    createdAt: BASE + 1 * DAY_MS,
    kind: "reflection",
    priority: "medium",
    source: { kind: "agent" },
  },
  {
    id: "e",
    createdAt: BASE + 3 * DAY_MS,
    kind: "observation",
    priority: "high",
    source: { kind: "user" },
  },
];

describe("MemoryDb.queryObservations", () => {
  testIfDocker("returns all rows newest-first when unfiltered", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations();
      expect(rows.map((r) => r.id)).toEqual(["e", "d", "c", "b", "a"]);
    });
  });

  testIfDocker("filters by kind", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({ kind: "reflection" });
      expect(rows.map((r) => r.id)).toEqual(["d", "b"]);
    });
  });

  testIfDocker("filters by priority", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({ priority: "high" });
      expect(rows.map((r) => r.id)).toEqual(["e", "c", "b"]);
    });
  });

  testIfDocker("filters by source kind", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({ source: "agent" });
      expect(rows.map((r) => r.id)).toEqual(["d", "b"]);
    });
  });

  testIfDocker("filters by an inclusive createdAt window", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({
        fromMs: BASE - 2 * DAY_MS,
        toMs: BASE + 1 * DAY_MS,
      });
      expect(rows.map((r) => r.id)).toEqual(["d", "c", "b"]);
    });
  });

  testIfDocker("combines filters with AND semantics", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({
        kind: "reflection",
        source: "agent",
        fromMs: BASE,
      });
      expect(rows.map((r) => r.id)).toEqual(["d"]);
    });
  });

  testIfDocker("returns an empty list when nothing matches", async () => {
    await withDb(async (db) => {
      await seed(db, SAMPLE);
      const rows = await db.queryObservations({ kind: "manual", priority: "low" });
      expect(rows).toEqual([]);
    });
  });
});

describe("duet memory query mode", () => {
  testIfDocker("emits a JSON array of scored rows, newest-first", async () => {
    await withDb(async (db, dbPath) => {
      await seed(db, SAMPLE);
      await db.close();
      const out = await captureJson(["--json", "--type", "reflection"], dbPath);
      expect(out.map((r) => r.id)).toEqual(["d", "b"]);
      for (const row of out) {
        const observation = observationFromScoredRow(row);
        expect(typeof row.score).toBe("number");
        expect(row.score).toBeCloseTo(scoreObservation(observation, Date.now()), 2);
      }
    });
  });

  testIfDocker("manual rows carry the manual-bias multiplier in their score", async () => {
    await withDb(async (db, dbPath) => {
      // Two equal-priority, equal-recency rows: one manual, one observation.
      // The manual row's score must dominate by the manual-bias multiplier,
      // matching the runner's loadGlobalPack ranking rather than the
      // reflection-only observationScore baseline.
      const fixtures: FixtureInput[] = [
        { id: "m", createdAt: BASE, kind: "manual", priority: "high", source: { kind: "system" } },
        {
          id: "o",
          createdAt: BASE,
          kind: "observation",
          priority: "high",
          source: { kind: "user" },
        },
      ];
      await seed(db, fixtures);
      await db.close();
      const out = await captureJson(["--json", "--priority", "high"], dbPath);
      const manual = out.find((r) => r.id === "m")!;
      const obs = out.find((r) => r.id === "o")!;
      const now = Date.now();
      expect(manual.score).toBeGreaterThan(obs.score);
      expect(manual.score / obs.score).toBeCloseTo(100, 0);
      expect(manual.score).toBeCloseTo(scoreObservation(observationFromScoredRow(manual), now), 2);
    });
  });

  testIfDocker("prints a friendly message when no rows match (table mode)", async () => {
    await withDb(async (db, dbPath) => {
      await seed(db, SAMPLE);
      await db.close();
      const { stdout } = await capture(["--priority", "low", "--type", "manual"], dbPath);
      expect(stdout).toContain("No memories matched");
    });
  });
});

describe("parseMemoryArgs", () => {
  function parse(args: string[]) {
    return parseMemoryArgs(args);
  }

  test("bare invocation stays in TUI mode (no query)", () => {
    const opts = parse([]);
    expect(opts?.queryMode).toBe(false);
    expect(parse(["--db", "/tmp/x.db"])?.queryMode).toBe(false);
    expect(parse(["--wait", "5"])?.queryMode).toBe(false);
  });

  test("--json or any filter flag switches to query mode", () => {
    expect(parse(["--json"])?.queryMode).toBe(true);
    expect(parse(["--type", "manual"])?.queryMode).toBe(true);
    expect(parse(["--priority", "high"])?.queryMode).toBe(true);
    expect(parse(["--source", "agent"])?.queryMode).toBe(true);
    expect(parse(["--from", "2026-06-26"])?.queryMode).toBe(true);
    expect(parse(["--to", "2026-06-26"])?.queryMode).toBe(true);
  });

  test("parses --type/--kind as the same axis", () => {
    expect(parse(["--type", "reflection"])?.filters.kind).toBe("reflection");
    expect(parse(["--kind", "manual"])?.filters.kind).toBe("manual");
  });

  test("parses a date-only --from as start-of-day UTC", () => {
    const opts = parse(["--from", "2026-06-26"]);
    expect(opts?.filters.fromMs).toBe(Date.UTC(2026, 5, 26, 0, 0, 0, 0));
  });

  test("parses a date-only --to as end-of-day UTC", () => {
    const opts = parse(["--to", "2026-06-26"]);
    expect(opts?.filters.toMs).toBe(Date.UTC(2026, 5, 26, 23, 59, 59, 999));
  });

  test("parses a full datetime --from as UTC", () => {
    const opts = parse(["--from", "2026-06-26T12:30:00"]);
    expect(opts?.filters.fromMs).toBe(Date.UTC(2026, 5, 26, 12, 30, 0, 0));
  });

  test("sets the --json flag", () => {
    expect(parse(["--json"])?.json).toBe(true);
    expect(parse([])?.json).toBe(false);
  });

  test("parses --wait in seconds", () => {
    expect(parse(["--wait", "2.5"])?.waitBudgetMs).toBe(2500);
  });

  test("rejects missing or invalid flag values", () => {
    using exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    using errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(() => parse(["--type"])).toThrow("exit");
    expect(() => parse(["--priority", "urgent"])).toThrow("exit");
    expect(() => parse(["--from", "tomorrow"])).toThrow("exit");
    expect(() => parse(["--from", "2026-06-27", "--to", "2026-06-26"])).toThrow("exit");
    // Impossible calendar dates are rejected, not silently normalized.
    expect(() => parse(["--from", "2026-02-31"])).toThrow("exit");
    expect(() => parse(["--to", "2026-06-31"])).toThrow("exit");
    expect(() => parse(["--from", "2026-02-31T00:00:00"])).toThrow("exit");

    expect(exitSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((args) => args.join("\n")).join("\n")).toContain("Fatal:");
  });
});

describe("formatMemoryTable", () => {
  test("renders a header and one row per observation", () => {
    const now = Date.now();
    const rows = SAMPLE.slice(0, 2).map((f) => {
      const obs: Observation = {
        id: f.id,
        createdAt: f.createdAt,
        lastUsedAt: f.createdAt,
        kind: f.kind ?? "observation",
        observedDate: new Date(f.createdAt).toISOString().slice(0, 10),
        priority: f.priority ?? "medium",
        source: f.source ?? { kind: "system" },
        content: `content for ${f.id}`,
        tags: [],
      };
      return { ...obs, score: scoreObservation(obs, now) };
    });
    const table = formatMemoryTable(rows);
    expect(table).toContain("MEMORY ID");
    expect(table).toContain("SCORE");
    expect(table.split("\n")).toHaveLength(3);
  });

  test("renders an empty-state line for no rows", () => {
    expect(formatMemoryTable([])).toContain("No memories matched");
  });
});

interface ScoredJsonRow extends Observation {
  score: number;
}

function observationFromScoredRow(row: ScoredJsonRow): Observation {
  return {
    id: row.id,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    sessionId: row.sessionId,
    kind: row.kind,
    observedDate: row.observedDate,
    referencedDate: row.referencedDate,
    relativeDate: row.relativeDate,
    timeOfDay: row.timeOfDay,
    priority: row.priority,
    source: row.source,
    content: row.content,
    tags: row.tags,
  };
}

async function capture(args: string[], dbPath: string): Promise<{ stdout: string }> {
  let stdout = "";
  const sink = {
    write(chunk: string | Uint8Array): boolean {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const options = parseMemoryArgs([...args, "--db", dbPath]);
  await runMemoryQuery(options!, { stdout: sink });
  return { stdout };
}

async function captureJson(args: string[], dbPath: string): Promise<ScoredJsonRow[]> {
  const { stdout } = await capture(args, dbPath);
  return JSON.parse(stdout) as ScoredJsonRow[];
}
