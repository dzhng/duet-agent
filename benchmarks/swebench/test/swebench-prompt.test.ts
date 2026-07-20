import { describe, expect, test } from "bun:test";

import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";

describe("SWE-bench rollout prompt", () => {
  test("passes the canonical issue through without benchmark workflow guidance", () => {
    const prompt = buildRolloutPrompt({
      problemStatement: "\n  Fix the production implementation.\n",
    });

    expect(prompt).toBe("Fix the production implementation.");
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toContain("ask_advisor");
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toContain("consultation");
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toMatch(/modify existing tests/i);
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toMatch(/commit changes/i);
    expect(`${SWEBENCH_SYSTEM_PROMPT}\n${prompt}`).not.toMatch(/cache|artifact|runtime file/i);
  });

  test("does not prescribe workflow, duration, tool counts, or validation scheduling", () => {
    expect(SWEBENCH_SYSTEM_PROMPT).toBe("Complete the task unattended.");
  });
});
