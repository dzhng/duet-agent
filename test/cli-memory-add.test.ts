import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { MemoryDb } from "../src/cli/memory-db.js";
import { parseMemoryAddArgs, runMemoryAddCommand } from "../src/cli/memory-add.js";
import { testIfDocker } from "./helpers/docker-only.js";

// `fail()` (bad flags, empty content) calls process.exit(1). Patch it to throw
// so the pure parser tests can assert on the error path.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

describe("parseMemoryAddArgs", () => {
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

  test("joins positional content and applies defaults", () => {
    const options = parseMemoryAddArgs(["Doughy", "doubles", "in", "4h"]);
    expect(options!.content).toBe("Doughy doubles in 4h");
    expect(options!.priority).toBe("medium");
    expect(options!.tags).toEqual([]);
    expect(options!.waitBudgetMs).toBeUndefined();
  });

  test("collects repeated --tag and parses --priority", () => {
    const options = parseMemoryAddArgs([
      "--priority",
      "high",
      "--tag",
      "pets",
      "--tag",
      "personal",
      "a note",
    ]);
    expect(options!.priority).toBe("high");
    expect(options!.tags).toEqual(["pets", "personal"]);
    expect(options!.content).toBe("a note");
  });

  test("rejects an invalid --priority value", () => {
    expect(() => parseMemoryAddArgs(["--priority", "urgent", "x"])).toThrow(ExitCalled);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseMemoryAddArgs(["--nope", "x"])).toThrow(ExitCalled);
  });

  test("parses --source, --session, and --json", () => {
    const options = parseMemoryAddArgs([
      "--source",
      "import",
      "--session",
      "sess_42",
      "--json",
      "a note",
    ]);
    expect(options!.source).toBe("import");
    expect(options!.sessionId).toBe("sess_42");
    expect(options!.json).toBe(true);
  });

  test("defaults source to user and leaves sessionId/json off", () => {
    const options = parseMemoryAddArgs(["a note"]);
    expect(options!.source).toBe("user");
    expect(options!.sessionId).toBeUndefined();
    expect(options!.json).toBe(false);
  });

  test("rejects an invalid --source value", () => {
    expect(() => parseMemoryAddArgs(["--source", "train", "x"])).toThrow(ExitCalled);
  });

  test("leaves content empty when only flags are given (stdin fallback)", () => {
    const options = parseMemoryAddArgs(["--priority", "low"]);
    expect(options!.content).toBe("");
    expect(options!.priority).toBe("low");
  });
});

describe("runMemoryAddCommand", () => {
  testIfDocker("writes a manual, user-sourced row from positional content", async () => {
    await withTempDb(async (dbPath) => {
      const { io, output } = makeIo();
      await runMemoryAddCommand(
        [
          "--db",
          dbPath,
          "--priority",
          "high",
          "--tag",
          "pets",
          "--tag",
          "personal",
          "Doughy doubles in 4 hours at room temp",
        ],
        io,
      );

      expect(output()).toMatch(
        /^Added high-priority memory mem_.+ \(\d{4}-\d{2}-\d{2}\) \[pets, personal\]\n$/,
      );

      // Reopen the database and prove the stored row carries the exact values,
      // not just that a row exists.
      const stored = await readBack(dbPath);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.kind).toBe("note");
      expect(stored[0]!.source).toEqual({ kind: "user" });
      expect(stored[0]!.sessionId).toBeUndefined();
      expect(stored[0]!.content).toBe("Doughy doubles in 4 hours at room temp");
      expect(stored[0]!.tags).toEqual(["pets", "personal"]);
      expect(stored[0]!.priority).toBe("high");
    });
  });

  testIfDocker("stores --source and --session and echoes a canonical JSON object", async () => {
    await withTempDb(async (dbPath) => {
      const { io, output } = makeIo();
      await runMemoryAddCommand(
        [
          "--db",
          dbPath,
          "--source",
          "api",
          "--session",
          "sess_abc",
          "--priority",
          "low",
          "--tag",
          "billing",
          "--json",
          "Enterprise discounts cap at 20%",
        ],
        io,
      );

      const emitted = JSON.parse(output());
      expect(emitted.id).toMatch(/^mem_/);
      expect(emitted.content).toBe("Enterprise discounts cap at 20%");
      expect(emitted.kind).toBe("note");
      expect(emitted.source).toBe("api");
      expect(emitted.priority).toBe("low");
      expect(emitted.sessionId).toBe("sess_abc");
      expect(emitted.tags).toEqual(["billing"]);
      // On insert lastUsedAt equals createdAt, packScore is present, and the
      // query-relevance score is absent (not null) on an add.
      expect(emitted.lastUsedAt).toBe(emitted.createdAt);
      expect(typeof emitted.packScore).toBe("number");
      expect("relevanceScore" in emitted).toBe(false);

      // Prove the row persisted with the exact source and session, not just
      // that the echoed JSON looked right.
      const stored = await readBack(dbPath);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.source).toEqual({ kind: "api" });
      expect(stored[0]!.sessionId).toBe("sess_abc");
      expect(stored[0]!.content).toBe("Enterprise discounts cap at 20%");
    });
  });

  testIfDocker("writes the embedding row synchronously when the embed client works", async () => {
    await withTempDb(async (dbPath) => {
      const batches: string[][] = [];
      const { io, output } = makeIo();
      io.embed = async (inputs: string[]) => {
        batches.push(inputs);
        return {
          embeddings: inputs.map(() => Array(3072).fill(1)),
          model: "test-model",
        };
      };
      await runMemoryAddCommand(
        ["--db", dbPath, "Northstar Robotics keeps enterprise discounts at 20 percent"],
        io,
      );

      expect(output()).toContain("Added medium-priority memory mem_");
      expect(batches).toEqual([["Northstar Robotics keeps enterprise discounts at 20 percent"]]);

      // The vector landed in the same command — no backfill worker runs
      // in this one-shot process, so a missing row here would stay
      // invisible to semantic recall until some later runner drains it.
      const embedded = await readEmbeddings(dbPath);
      expect(embedded).toHaveLength(1);
      expect(embedded[0]!.model).toBe("test-model");
      expect(embedded[0]!.content).toBe(
        "Northstar Robotics keeps enterprise discounts at 20 percent",
      );
    });
  });

  testIfDocker("still adds the row when the embed client throws", async () => {
    await withTempDb(async (dbPath) => {
      const { io, output } = makeIo();
      io.embed = async () => {
        throw new Error("simulated embedding outage");
      };
      await runMemoryAddCommand(["--db", dbPath, "Survives the embedding outage"], io);

      // The add degrades exactly as before: the row lands (for a later
      // backfill to embed) and the command reports success.
      expect(output()).toContain("Added medium-priority memory mem_");
      const stored = await readBack(dbPath);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.content).toBe("Survives the embedding outage");
      expect(await readEmbeddings(dbPath)).toHaveLength(0);
    });
  });

  testIfDocker("reads content from stdin when no positional args are given", async () => {
    await withTempDb(async (dbPath) => {
      const { io, output } = makeIo("piped memory text\n");
      await runMemoryAddCommand(["--db", dbPath], io);

      expect(output()).toContain("Added medium-priority memory mem_");
      const stored = await readBack(dbPath);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.content).toBe("piped memory text");
      expect(stored[0]!.priority).toBe("medium");
      expect(stored[0]!.tags).toEqual([]);
    });
  });
});

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duet-memory-add-"));
  try {
    await fn(join(dir, "memory.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readBack(dbPath: string) {
  const db = await MemoryDb.open(dbPath);
  try {
    return await db.listRanked({ limit: 25, offset: 0 });
  } finally {
    await db.close();
  }
}

/** Embedding rows joined to their observation content, via a fresh handle. */
async function readEmbeddings(dbPath: string): Promise<Array<{ content: string; model: string }>> {
  const db = await PGlite.create({ dataDir: dbPath, extensions: { vector } });
  try {
    const result = await db.query<{ content: string; model: string }>(
      `SELECT o.content, e.model FROM observation_embeddings e
       JOIN observations o ON o.id = e.observation_id`,
    );
    return result.rows;
  } finally {
    await db.close();
  }
}

function makeIo(stdinText = "") {
  const chunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // Piped stdin (isTTY falsy) when text is provided; a TTY stub otherwise so
  // the command does not block waiting on an empty pipe in the positional path.
  const stdin = Object.assign(Readable.from(stdinText ? [stdinText] : []), {
    isTTY: stdinText ? false : true,
  });
  const io: NonNullable<Parameters<typeof runMemoryAddCommand>[1]> = {
    stdout: stdout as NodeJS.WritableStream,
    stdin,
  };
  return {
    io,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}
