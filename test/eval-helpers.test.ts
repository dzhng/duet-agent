import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bestOfAttempts } from "./helpers/best-of.js";
import { judge } from "./helpers/judge.js";

const originalJudgeModel = process.env.JUDGE_MODEL;
afterEach(() => {
  if (originalJudgeModel === undefined) delete process.env.JUDGE_MODEL;
  else process.env.JUDGE_MODEL = originalJudgeModel;
});

describe("eval evidence", () => {
  test("judge honors the environment selection without making a provider request", async () => {
    process.env.JUDGE_MODEL = "eval-judge-missing-model";
    await expect(judge({ prompt: "Check the answer", value: "answer" })).rejects.toThrow(
      "Unknown model shorthand: eval-judge-missing-model",
    );
  });
  test("a successful retry still reports the original failure", async () => {
    const failure = new Error("first attempt rejected the worker output");
    const report = spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    try {
      await bestOfAttempts(2, async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
      });
      expect(report.mock.calls).toEqual([["Eval attempt 1/2 failed:", failure]]);
      expect(attempts).toBe(2);
    } finally {
      report.mockRestore();
    }
  });

  test("an explicit judge selection takes precedence over the environment", async () => {
    process.env.JUDGE_MODEL = "eval-judge-environment";
    await expect(
      judge({ prompt: "Check the answer", value: "answer", model: "eval-judge-explicit" }),
    ).rejects.toThrow("Unknown model shorthand: eval-judge-explicit");
  });

  test("exhaustion reports each failure and throws the final failure unchanged", async () => {
    const failures = [new Error("first failure"), new Error("last failure")];
    const report = spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    try {
      await expect(
        bestOfAttempts(2, async () => {
          throw failures[attempts++];
        }),
      ).rejects.toBe(failures[1]);
      expect(report.mock.calls).toEqual([
        ["Eval attempt 1/2 failed:", failures[0]],
        ["Eval attempt 2/2 failed:", failures[1]],
      ]);
      expect(attempts).toBe(2);
    } finally {
      report.mockRestore();
    }
  });
});
