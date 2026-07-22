import { resolve } from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { lexMemorySourceFlags } from "../src/cli/memory-sources.js";
import { WRITE_TARGET_USAGE_ERROR } from "../src/cli/memory-sources.js";
import { printMemoryAddHelp, printMemoryRecallHelp, printTrainHelp } from "../src/cli/help.js";
import { parseMemoryAddArgs } from "../src/cli/memory-add.js";
import { parseMemoryRecallArgs } from "../src/cli/memory-recall.js";
import { parseTrainArgs } from "../src/cli/train.js";

const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
});

describe("memory source flag lexer", () => {
  test("extracts repeatable store and DB flags while preserving both source orders", () => {
    expect(
      lexMemorySourceFlags(
        ["list", "--db", "one.db", "--store", "near", "--json", "--store", "far", "--db", "two.db"],
        "/project",
      ),
    ).toEqual({
      args: ["list", "--json"],
      flags: {
        stores: [resolve("/project/near"), resolve("/project/far")],
        dbs: [resolve("/project/one.db"), resolve("/project/two.db")],
      },
    });
  });

  test("train create rejects two explicit write targets with the shared usage error", () => {
    let message = "";
    const errorSpy = spyOn(console, "error").mockImplementation((value) => {
      message = String(value);
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    restorers.push(
      () => errorSpy.mockRestore(),
      () => exitSpy.mockRestore(),
    );

    expect(() => parseTrainArgs(["docs", "--store", "files", "--db", "memory.db"])).toThrow("exit");
    expect(message).toBe(`Fatal: ${WRITE_TARGET_USAGE_ERROR}`);
  });

  test("memory add rejects repeated write targets with the same usage error", () => {
    let message = "";
    const errorSpy = spyOn(console, "error").mockImplementation((value) => {
      message = String(value);
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    restorers.push(
      () => errorSpy.mockRestore(),
      () => exitSpy.mockRestore(),
    );

    expect(() => parseMemoryAddArgs(["--store", "one", "--store", "two", "note"])).toThrow("exit");
    expect(message).toBe(`Fatal: ${WRITE_TARGET_USAGE_ERROR}`);
  });

  test("recall rejects file stores with a DB-only usage error", () => {
    let message = "";
    const errorSpy = spyOn(console, "error").mockImplementation((value) => {
      message = String(value);
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    restorers.push(
      () => errorSpy.mockRestore(),
      () => exitSpy.mockRestore(),
    );

    expect(() => parseMemoryRecallArgs(["--store", "memories", "billing"])).toThrow("exit");
    expect(message).toBe(
      "Fatal: duet memory recall does not support --store; use --db <file>. " +
        "Store memories are loaded into context automatically.",
    );
  });

  test("help documents create exclusivity, repeatable reads, and recall's DB-only boundary", () => {
    const messages: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((value) => {
      messages.push(String(value));
    });
    restorers.push(() => logSpy.mockRestore());

    printTrainHelp();
    printMemoryAddHelp();
    printMemoryRecallHelp();

    const output = messages.join("\n");
    expect(output).toContain("[--store <folder> | --db <file>]");
    expect(output).toContain("[--store <folder>]... [--db <file>]...");
    expect(output).toContain("Passing more than one backend is a usage error");
    expect(output).toContain("This command is DB-only; --store is rejected");
  });
});
