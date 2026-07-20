import { describe, expect, test } from "bun:test";

import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";

describe("SWE-bench rollout prompt", () => {
  test("leaves advisor scheduling to the product package and states only the submission contract", () => {
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
    expect(SWEBENCH_SYSTEM_PROMPT).toContain("do not modify existing tests");
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toMatch(/commit changes/i);
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toMatch(/cache|artifact|runtime file/i);
  });

  test("does not prescribe work duration, tool counts, or validation scheduling", () => {
    expect(SWEBENCH_SYSTEM_PROMPT).not.toMatch(/minute|step limit|exactly once|must call/i);
  });
});
