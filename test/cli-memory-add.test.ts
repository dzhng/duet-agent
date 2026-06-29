import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
  return {
    io: { stdout: stdout as NodeJS.WritableStream, stdin },
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}
