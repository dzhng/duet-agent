import { describe, expect, test } from "bun:test";

import { buildRolloutPrompt } from "../benchmarks/swebench/src/prompt.js";

describe("SWE-bench rollout prompt", () => {
  test("defines one controlled advisor exposure and a clean final patch", () => {
    const prompt = buildRolloutPrompt({
      entry: {
        instanceId: "org__repo-1",
        language: "Go",
        repo: "org/repo",
        baseCommit: "base",
      },
      problemStatement: "Fix the production implementation.",
    });

    expect(prompt).toContain(
      "If an ask_advisor tool is available, call it exactly once after your initial inspection and before making implementation edits.",
    );
    expect(prompt).toContain(
      "Before finishing, revert any test, cache, benchmark, or runtime files changed during your work",
    );
  });
});
