import path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { buildTrainSynthesisConfig, parseTrainArgs } from "../src/cli/train.js";
import { DEFAULT_MEMORY_DB_PATH } from "../src/session/session-manager.js";

// `parseTrainArgs` calls `fail()` on bad input, which calls `process.exit(1)`.
// We patch exit to throw so the test can assert on the error path instead of
// killing the test runner.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

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

describe("parseTrainArgs", () => {
  test("disables both durable memory sources for the synthesis sub-runner", () => {
    const config = buildTrainSynthesisConfig({ folder: "/tmp/corpus", model: "test:model" });
    expect(config.memoryDbPath).toBe(false);
    expect(config.memoryStores).toBe(false);
  });

  test("rejects an empty arg list", () => {
    expect(() => parseTrainArgs([])).toThrow(ExitCalled);
  });

  test("accepts a positional folder and resolves it to an absolute path", () => {
    const result = parseTrainArgs(["./docs"]);
    expect(result).toBeDefined();
    expect(result!.folder).toBe(path.resolve("./docs"));
    expect(result!.slug).toBe(path.basename(path.resolve("./docs")).toLowerCase());
    // Model is resolved at run time via `resolveCliModel`; the parser leaves
    // it undefined unless the user passed `--model`.
    expect(result!.model).toBeUndefined();
    expect(result!.dbPath).toBe(DEFAULT_MEMORY_DB_PATH);
    expect(result!.waitBudgetMs).toBeUndefined();
  });

  test("--slug overrides the derived slug", () => {
    const result = parseTrainArgs(["./docs", "--slug", "my-slug"]);
    expect(result!.slug).toBe("my-slug");
  });

  test("derives slug from basename via lowercase + non-alphanum collapse", () => {
    // `My Docs` has a space and mixed case; the sanitizer should collapse
    // both into a single dash and lowercase the rest.
    const result = parseTrainArgs(["./My Docs"]);
    expect(result!.slug).toBe("my-docs");
  });

  test("collapses runs of non-alphanum characters and trims edge dashes", () => {
    const result = parseTrainArgs(["./folder", "--slug", "!!Hello___World!!"]);
    expect(result!.slug).toBe("hello-world");
  });

  test("--model overrides the default memory model", () => {
    const result = parseTrainArgs(["./docs", "--model", "opus-4.7"]);
    expect(result!.model).toBe("opus-4.7");
  });

  test("--db resolves to an absolute path", () => {
    const result = parseTrainArgs(["./docs", "--db", "./foo.db"]);
    expect(result!.dbPath).toBe(path.resolve("./foo.db"));
  });

  test("--wait accepts a non-negative number of seconds", () => {
    const result = parseTrainArgs(["./docs", "--wait", "2.5"]);
    expect(result!.waitBudgetMs).toBe(2500);
  });

  test("--wait rejects non-numeric values", () => {
    expect(() => parseTrainArgs(["./docs", "--wait", "soon"])).toThrow(ExitCalled);
  });

  test("unknown flag fails", () => {
    expect(() => parseTrainArgs(["./docs", "--bogus"])).toThrow(ExitCalled);
  });

  test("a flag with a missing value fails", () => {
    expect(() => parseTrainArgs(["./docs", "--slug"])).toThrow(ExitCalled);
  });

  test("extra positional argument fails", () => {
    expect(() => parseTrainArgs(["./docs", "./other"])).toThrow(ExitCalled);
  });

  test("--help returns undefined without parsing further", () => {
    // --help short-circuits before slug derivation, so no folder is required.
    expect(parseTrainArgs(["--help"])).toBeUndefined();
    expect(parseTrainArgs(["-h"])).toBeUndefined();
  });

  test("a slug that sanitizes to empty fails", () => {
    expect(() => parseTrainArgs(["./folder", "--slug", "!!!"])).toThrow(ExitCalled);
  });
});
