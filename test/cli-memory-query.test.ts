import { describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb, scoreObservation } from "../src/cli/memory-db.js";
import type { MemoryJson } from "../src/cli/memory-json.js";
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

interface FixtureInputWithSession extends FixtureInput {
  sessionId?: string;
}

async function seed(db: MemoryDb, fixtures: FixtureInputWithSession[]): Promise<void> {
  const pg = (db as unknown as { db: import("@electric-sql/pglite").PGlite }).db;
  for (const f of fixtures) {
    await pg.query(
      `INSERT INTO observations (
        id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date,
        time_of_day, priority, source_json, content, tags_json
      ) VALUES ($1, $2, $3, $9, $4, $5, NULL, NULL, NULL, $6, $7, $8, '[]')`,
      [
        f.id,
        f.createdAt,
        f.createdAt,
        f.kind ?? "observation",
        new Date(f.createdAt).toISOString().slice(0, 10),
        f.priority ?? "medium",
        JSON.stringify(f.source ?? { kind: "system" }),
        f.content ?? `content for ${f.id}`,
        f.sessionId ?? null,
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

  testIfDocker("filters by sessionId", async () => {
    await withDb(async (db) => {
      await seed(db, [
        { id: "s1", createdAt: BASE, sessionId: "session_alpha" },
        { id: "s2", createdAt: BASE - DAY_MS, sessionId: "session_beta" },
        { id: "s3", createdAt: BASE - 2 * DAY_MS, sessionId: "session_alpha" },
        { id: "s4", createdAt: BASE - 3 * DAY_MS },
      ]);
      const rows = await db.queryObservations({ sessionId: "session_alpha" });
      expect(rows.map((r) => r.id)).toEqual(["s1", "s3"]);
      expect(rows.every((r) => r.sessionId === "session_alpha")).toBe(true);
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
  testIfDocker("emits a JSON array of canonical rows, newest-first", async () => {
    await withDb(async (db, dbPath) => {
      await seed(db, SAMPLE);
      await db.close();
      const out = await captureJson(["--json", "--type", "reflection"], dbPath);
      expect(out.map((r) => r.id)).toEqual(["d", "b"]);
      for (const row of out) {
        // Timestamps are ISO 8601 strings, not epoch millis.
        expect(row.createdAt).toBe(new Date(row.createdAt).toISOString());
        expect(row.lastUsedAt).toBe(new Date(row.lastUsedAt).toISOString());
        // `source` is flattened to its kind string, and the pack score is
        // named `packScore` (never `score`, never `relevanceScore`).
        expect(typeof row.source).toBe("string");
        expect(typeof row.packScore).toBe("number");
        expect(row).not.toHaveProperty("score");
        expect(row).not.toHaveProperty("relevanceScore");
        expect(row.packScore).toBeCloseTo(
          scoreObservation(observationFromJsonRow(row), Date.now()),
          2,
        );
      }
    });
  });

  testIfDocker("echoes sessionId and filters JSON output by --session", async () => {
    await withDb(async (db, dbPath) => {
      await seed(db, [
        { id: "j1", createdAt: BASE, sessionId: "session_alpha" },
        { id: "j2", createdAt: BASE - DAY_MS, sessionId: "session_beta" },
      ]);
      await db.close();
      const out = await captureJson(["--json", "--session", "session_alpha"], dbPath);
      expect(out.map((r) => r.id)).toEqual(["j1"]);
      expect(out[0]!.sessionId).toBe("session_alpha");
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
      expect(manual.packScore!).toBeGreaterThan(obs.packScore!);
      expect(manual.packScore! / obs.packScore!).toBeCloseTo(100, 0);
      expect(manual.packScore).toBeCloseTo(
        scoreObservation(observationFromJsonRow(manual), now),
        2,
      );
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
    expect(parse(["--session", "session_alpha"])?.queryMode).toBe(true);
    expect(parse(["--from", "2026-06-26"])?.queryMode).toBe(true);
    expect(parse(["--to", "2026-06-26"])?.queryMode).toBe(true);
  });

  test("parses --type/--kind as the same axis", () => {
    expect(parse(["--type", "reflection"])?.filters.kind).toBe("reflection");
    expect(parse(["--kind", "manual"])?.filters.kind).toBe("manual");
    // `note` is a real ObservationKind (user-added `duet memory add` rows);
    // it must be filterable like any other kind.
    expect(parse(["--type", "note"])?.filters.kind).toBe("note");
  });

  test("parses --session as a row filter", () => {
    expect(parse(["--session", "session_alpha"])?.filters.sessionId).toBe("session_alpha");
  });

  test("accepts the expanded --source union", () => {
    expect(parse(["--source", "api"])?.filters.source).toBe("api");
    expect(parse(["--source", "import"])?.filters.source).toBe("import");
    expect(parse(["--source", "system"])?.filters.source).toBe("system");
    expect(parse(["--source", "user"])?.filters.source).toBe("user");
    expect(parse(["--source", "agent"])?.filters.source).toBe("agent");
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
      return { ...obs, packScore: scoreObservation(obs, now) };
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

type MemoryJsonRow = MemoryJson;

/**
 * Rebuild the runtime {@link Observation} from a canonical JSON row so the
 * test can recompute the expected pack score. Inverts {@link toMemoryJson}:
 * ISO timestamps back to epoch millis, flat `source` string back to the
 * structured `{ kind }` union.
 */
function observationFromJsonRow(row: MemoryJsonRow): Observation {
  return {
    id: row.id,
    createdAt: Date.parse(row.createdAt),
    lastUsedAt: Date.parse(row.lastUsedAt),
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
    kind: row.kind,
    observedDate: row.observedDate,
    ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
    ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
    ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
    priority: row.priority,
    source: { kind: row.source },
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

async function captureJson(args: string[], dbPath: string): Promise<MemoryJsonRow[]> {
  const { stdout } = await capture(args, dbPath);
  return JSON.parse(stdout) as MemoryJsonRow[];
}
