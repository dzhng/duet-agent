import { describe, expect, test } from "bun:test";
import { AdvisorTurnLifecycle } from "../src/model-routing/advisor-lifecycle.js";

describe("AdvisorTurnLifecycle", () => {
  test("a completion checkpoint issued before consultation re-arms at most once", () => {
    const lifecycle = new AdvisorTurnLifecycle(0);

    expect(lifecycle.takeCompletionCheckpoint(3)).toBe(true);
    lifecycle.noteExecutedTools(["bash"]);
    expect(lifecycle.takeCompletionCheckpoint(4)).toBe(true);

    lifecycle.noteExecutedTools(["bash"]);
    expect(lifecycle.takeCompletionCheckpoint(5)).toBe(false);
  });
});
