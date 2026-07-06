import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  formatRecallTable,
  parseMemoryRecallArgs,
  runMemoryRecallCommand,
} from "../src/cli/memory-recall.js";
import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

// `fail()` calls process.exit(1); patch it to throw so parser tests can assert
// the rejection path instead of tearing down the test runner.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

describe("parseMemoryRecallArgs", () => {
  let exitSpy: ReturnType<typeof spyOn> | undefined;
  let errorSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  test("joins positional query and applies defaults", () => {
    const options = parseMemoryRecallArgs(["wire", "byte", "budget"]);
    expect(options!.query).toBe("wire byte budget");
    expect(options!.scope).toBe("all");
    expect(options!.limit).toBe(8);
    expect(options!.expand).toBe(false);
    expect(options!.sessionId).toBeUndefined();
  });

  test("accepts the query via --query", () => {
    const options = parseMemoryRecallArgs(["--query", "the gateway race"]);
    expect(options!.query).toBe("the gateway race");
  });

  test("combines --query with positional args", () => {
    const options = parseMemoryRecallArgs(["--query", "wire budget", "cap"]);
    expect(options!.query).toBe("wire budget cap");
  });

  test("parses scope, limit, expand, and session", () => {
    const options = parseMemoryRecallArgs([
      "--scope",
      "global",
      "--session",
      "sess_1",
      "--limit",
      "3",
      "--expand",
      "the gateway race",
    ]);
    expect(options!.scope).toBe("global");
    expect(options!.sessionId).toBe("sess_1");
    expect(options!.limit).toBe(3);
    expect(options!.expand).toBe(true);
    expect(options!.query).toBe("the gateway race");
  });

  test("rejects an empty query", () => {
    expect(() => parseMemoryRecallArgs(["--scope", "all"])).toThrow(ExitCalled);
  });

  test("rejects an invalid scope", () => {
    expect(() => parseMemoryRecallArgs(["--scope", "everything", "x"])).toThrow(ExitCalled);
  });

  test("rejects a non-positive limit", () => {
    expect(() => parseMemoryRecallArgs(["--limit", "0", "x"])).toThrow(ExitCalled);
  });

  test("requires --session for session/global scope", () => {
    expect(() => parseMemoryRecallArgs(["--scope", "session", "x"])).toThrow(ExitCalled);
    expect(() => parseMemoryRecallArgs(["--scope", "global", "x"])).toThrow(ExitCalled);
  });

  test("rejects unknown flags", () => {
    expect(() => parseMemoryRecallArgs(["--nope", "x"])).toThrow(ExitCalled);
  });
});

describe("formatRecallTable", () => {
  test("renders a ranked table with a header", () => {
    const table = formatRecallTable([obs("a", "First hit."), obs("b", "Second hit.")]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("MEMORY ID");
    expect(lines[1]!.trimStart().startsWith("1")).toBe(true);
    expect(lines[2]!.trimStart().startsWith("2")).toBe(true);
  });

  test("reports an empty result without crashing", () => {
    expect(formatRecallTable([])).toContain("No memories matched");
  });
});

describe("runMemoryRecallCommand", () => {
  testIfDocker("returns keyword-fused hits as JSON via the shared pipeline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-cli-recall-"));
    const dbPath = join(tempDir, "memory.db");
    const session = new MemorySession({
      path: dbPath,
      openOptions: {
        init: async (db) => {
          await runMigrations(db);
        },
      },
      idleCloseMs: 60_000,
    });
    try {
      await session.withDb(async (db) => {
        await db.exec(`
          INSERT INTO observations (
            id, created_at, last_used_at, session_id, kind, observed_date, priority,
            source_json, content, tags_json
          ) VALUES
            ('mem_budget', 1, 1, 'sess', 'reflection', '2026-05-07', 'high',
             '{"kind":"system"}', 'Wire-byte budget cap on the proxy is 4.5 MiB.', '[]'),
            ('mem_other', 2, 2, 'sess', 'observation', '2026-05-06', 'medium',
             '{"kind":"system"}', 'State machine routing handles recurring tasks.', '[]');
        `);
      });
      await session.dispose();

      const chunks: string[] = [];
      const stdout = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      });
      // A throwing embed exercises the keyword-only fallback with no network.
      const throwingEmbed = async () => {
        throw new Error("no embeddings in test");
      };

      await runMemoryRecallCommand(["--db", dbPath, "--json", "wire byte budget cap"], {
        stdout,
        embed: throwingEmbed,
      });

      const parsed = JSON.parse(chunks.join("")) as Array<Record<string, unknown>>;
      expect(parsed[0]?.id).toBe("mem_budget");
      expect(parsed.some((o) => o.id === "mem_other")).toBe(false);

      const top = parsed[0]!;
      // Both scores are named explicitly and present on every recall row.
      expect(typeof top.packScore).toBe("number");
      expect(typeof top.relevanceScore).toBe("number");
      // Timestamps serialize as ISO 8601 strings, not epoch millis.
      expect(top.createdAt).toBe(new Date(1).toISOString());
      expect(top.lastUsedAt).toBe(new Date(1).toISOString());
      // `source` is flattened to its kind string.
      expect(top.source).toBe("system");
      // No generic `score` field anywhere.
      expect(top.score).toBeUndefined();
    } finally {
      await session.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function obs(id: string, content: string): Observation {
  return {
    id,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    kind: "observation",
    observedDate: "2026-05-07",
    priority: "medium",
    source: { kind: "system" },
    content,
    tags: [],
  };
}
