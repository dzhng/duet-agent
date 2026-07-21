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

  test("requires a completed repository solution without prescribing how to produce it", () => {
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(/resolve the task/i);
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(/repository/i);
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(/working tree/i);
    expect(SWEBENCH_SYSTEM_PROMPT).toMatch(/complete solution/i);

    expect(SWEBENCH_SYSTEM_PROMPT).not.toMatch(/ask_advisor|advisor|consult/i);
    expect(SWEBENCH_SYSTEM_PROMPT).not.toMatch(/tool calls?|step limit|validation schedule/i);
    expect(SWEBENCH_SYSTEM_PROMPT).not.toMatch(/run tests? (?:before|after)|test first/i);
  });
});
