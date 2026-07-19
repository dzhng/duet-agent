import { describe, expect, test } from "bun:test";
import { evaluateStepTriggers } from "../src/model-routing/step-triggers.js";
import { syntheticUserMessage } from "../src/lib/synthetic-user-message.js";

describe("step-output routing triggers", () => {
  test("image blocks always request classification and make image presence sticky", () => {
    expect(evaluateStepTriggers({ blockTypes: ["text", "image"], text: "" }, undefined)).toEqual([
      { classify: true, facts: { hasImages: true } },
    ]);
  });

  test("configured keywords use case-insensitive substring matching", () => {
    const triggers = [{ name: "escalate", keywords: ["ESCALATE_ROUTE"] }];

    expect(
      evaluateStepTriggers({ blockTypes: ["text"], text: "please escalate_route now" }, triggers),
    ).toEqual([{ classify: true }]);
    expect(
      evaluateStepTriggers({ blockTypes: ["text"], text: "ordinary output" }, triggers),
    ).toEqual([]);
  });

  test("configured keywords ignore runtime-owned task plumbing", () => {
    const triggers = [{ name: "task", keywords: ["task settled"] }];

    expect(
      evaluateStepTriggers(
        {
          blockTypes: ["text"],
          text: syntheticUserMessage("A task settled while you were working."),
        },
        triggers,
      ),
    ).toEqual([]);
    expect(
      evaluateStepTriggers(
        { blockTypes: ["text"], text: "A genuine assistant says task settled." },
        triggers,
      ),
    ).toEqual([{ classify: true }]);
  });

  test("every matching configured trigger contributes an effect", () => {
    const triggers = [
      { name: "first", keywords: ["alpha"] },
      { name: "second", keywords: ["BETA"] },
    ];

    expect(evaluateStepTriggers({ blockTypes: [], text: "Alpha and beta" }, triggers)).toEqual([
      { classify: true },
      { classify: true },
    ]);
  });

  test("only evaluates the caller-provided bounded text", () => {
    const triggers = [{ name: "late", keywords: ["outside-limit"] }];
    const bounded = `outside-limit ${"x".repeat(2_100)}`.slice(-2_000);

    expect(evaluateStepTriggers({ blockTypes: [], text: bounded }, triggers)).toEqual([]);
  });
});
