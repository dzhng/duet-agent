import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryAddArgs } from "../src/cli/memory-add.js";
import { withMemoryDb } from "../src/cli/memory-db.js";
import { testIfDocker } from "./helpers/docker-only.js";

// The CLI signals its exit-code contract through `process.exit`; patch it to
// throw so a test can assert the code instead of tearing down the runner:
// 64 = usage/validation, 75 = lock-wait exhausted, 1 = generic runtime failure.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

describe("CLI exit codes", () => {
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

  test("a usage/validation error exits 64", () => {
    let caught: unknown;
    try {
      parseMemoryAddArgs(["--nope", "x"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitCalled);
    expect((caught as ExitCalled).code).toBe(64);
  });

  test("empty memory-add input exits 64", () => {
    let caught: unknown;
    try {
      // A `--priority` with no value is a missing-value usage error.
      parseMemoryAddArgs(["--priority"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExitCalled);
    expect((caught as ExitCalled).code).toBe(64);
  });

  testIfDocker("an exhausted memory-DB lock wait exits 75", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-exit-codes-"));
    // A live foreign pid is required to exercise the wait-then-timeout path:
    // `tryAcquireOpenLock` steals a lock file that holds the current pid.
    const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("spawn returned no pid");
    try {
      const dataDir = join(tempDir, "memory.db");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, ".duet-open.lock"), `${childPid}\n`, "utf8");

      let caught: unknown;
      try {
        await withMemoryDb(dataDir, async () => undefined, { waitBudgetMs: 150 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExitCalled);
      expect((caught as ExitCalled).code).toBe(75);
    } finally {
      child.kill();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
