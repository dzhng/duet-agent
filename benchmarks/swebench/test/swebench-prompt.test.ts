import { describe, expect, test } from "bun:test";

import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";

describe("SWE-bench rollout prompt", () => {
  test("leaves advisor scheduling to the product package and asks for a clean final patch", () => {
    const prompt = buildRolloutPrompt({
      entry: {
        instanceId: "org__repo-1",
        language: "Go",
        repo: "org/repo",
        baseCommit: "base",
      },
      problemStatement: "Fix the production implementation.",
    });

    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toContain("ask_advisor");
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toContain("consultation");
    expect(prompt).toContain(
      "Before finishing, revert any test, cache, benchmark, or runtime files changed during your work",
    );
  });

  test("bounds unattended validation without discarding the completed patch", () => {
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(
      /If a validation command is still running after two\s+minutes, stop that command/,
    );
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(/finish with the best patch\s+already produced/);
  });
});
