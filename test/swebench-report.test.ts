import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseSwebenchReport } from "../benchmarks/swebench/src/swebench-report.js";

describe("official SWE-bench report parser", () => {
  test("parses the captured v4.1.0 scorer report", async () => {
    const fixture = JSON.parse(
      await readFile(
        join(
          import.meta.dir,
          "..",
          "benchmarks",
          "swebench",
          "fixtures",
          "capacity-gold-report.json",
        ),
        "utf8",
      ),
    );
    expect(parseSwebenchReport(fixture)).toEqual({
      resolvedIds: ["apache__druid-13704"],
      unresolvedIds: [],
      errorIds: [],
      emptyPatchIds: [],
    });
  });

  test("rejects schema drift instead of treating a missing field as empty", () => {
    expect(() =>
      parseSwebenchReport({ resolved_ids: [], unresolved_ids: [], error_ids: [] }),
    ).toThrow("empty_patch_ids");
  });
});
