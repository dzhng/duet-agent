import { afterEach, beforeEach, describe, expect } from "bun:test";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";
import type { TurnQuestion } from "../src/types/protocol.js";

/**
 * Each row of the picker keymap table that the TUI implements. The pure
 * helpers in `cli.test.ts` already pin the building blocks
 * (`moveQuestionHighlight`, `commitActiveAnswer`, `restoreSavedAnswer`).
 * These tests prove the *dispatch* — that Up/Down, Space/Enter, ←/→, and
 * Escape route to the right helper for the active question's row type, and
 * that the composer-empty gate keeps Space/Enter typing characters when
 * the composer is non-empty.
 */

const SINGLE_THEN_MULTI_THEN_SINGLE: TurnQuestion[] = [
  {
    question: "Pick a deployment target",
    options: [{ label: "staging" }, { label: "production", description: "requires approval" }],
  },
  {
    question: "Which test suites should run before promotion?",
    multiSelect: true,
    options: [{ label: "unit" }, { label: "integration" }, { label: "e2e" }],
  },
  {
    question: "Confirm rollout window",
    options: [{ label: "now" }, { label: "tonight" }, { label: "next morning" }],
  },
];

describe("TUI keymap dispatch", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("Up/Down on single-select live-records highlight as the answer", async () => {
    await harness.pushAskTerminal([SINGLE_THEN_MULTI_THEN_SINGLE[0]!]);
    // Press Down once to highlight (and live-record) the first option, then
    // Down again to land on the second option. The single-select rule says
    // "highlight equals selection" so the most recent press should be the
    // dispatched answer.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    expect(harness.answerCalls[0]!.answers).toEqual({
      "Pick a deployment target": ["production"],
    });
    expect(harness.answerCalls[0]!.message).toBeUndefined();
  });

  testIfDocker(
    "Up/Down on multi-select moves highlight without committing a selection",
    async () => {
      await harness.pushAskTerminal([SINGLE_THEN_MULTI_THEN_SINGLE[1]!]);
      // Walk the highlight across all three options without pressing
      // Space/Enter to toggle. Multi-select highlight is purely
      // navigational — only toggles call `commitActiveAnswer` — so
      // advancing past with nothing checked must dispatch an answer map
      // *without* a key for the question (the absent key is what tells
      // the model the user did not pick anything).
      harness.mockInput.pressArrow("down");
      await harness.flush();
      harness.mockInput.pressArrow("down");
      await harness.flush();
      harness.mockInput.pressArrow("down");
      await harness.flush();
      harness.mockInput.pressArrow("down"); // onto Done
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForAnswer();

      expect(harness.answerCalls).toHaveLength(1);
      expect(harness.answerCalls[0]!.answers).toEqual({});
    },
  );

  testIfDocker("Space toggles a multi-select row; Done advances", async () => {
    await harness.pushAskTerminal([SINGLE_THEN_MULTI_THEN_SINGLE[1]!]);
    harness.mockInput.pressArrow("down"); // highlight unit
    await harness.flush();
    harness.mockInput.pressKey(" "); // toggle unit
    await harness.flush();
    harness.mockInput.pressArrow("down"); // highlight integration
    await harness.flush();
    harness.mockInput.pressArrow("down"); // highlight e2e
    await harness.flush();
    harness.mockInput.pressEnter(); // toggle e2e (Enter on regular row toggles too)
    await harness.flush();
    harness.mockInput.pressArrow("down"); // onto Done
    await harness.flush();
    harness.mockInput.pressEnter(); // advance via Done
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    expect(harness.answerCalls[0]!.answers).toEqual({
      "Which test suites should run before promotion?": ["unit", "e2e"],
    });
  });

  testIfDocker("Enter on a single-select advances; final Enter submits", async () => {
    await harness.pushAskTerminal(SINGLE_THEN_MULTI_THEN_SINGLE);
    // Q1 (single): Down → production; Enter advances.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.flush();
    // Q2 (multi): toggle integration via Space; advance via Done.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressKey(" ");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down"); // onto Done
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.flush();
    // Q3 (single): Down → tonight; Enter submits.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    expect(harness.answerCalls[0]!.answers).toEqual({
      "Pick a deployment target": ["production"],
      "Which test suites should run before promotion?": ["integration"],
      "Confirm rollout window": ["tonight"],
    });
  });

  testIfDocker("Left/Right commit the departing question and restore on revisit", async () => {
    await harness.pushAskTerminal(SINGLE_THEN_MULTI_THEN_SINGLE);
    // Q1: highlight production (live-record), then Right to Q2.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("right");
    await harness.flush();
    // Q2: toggle integration; Right to Q3.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressKey(" ");
    await harness.flush();
    harness.mockInput.pressArrow("right");
    await harness.flush();
    // Q3: highlight 'now', then Left back to Q2 (which should still hold
    // the integration toggle), then Left to Q1 (which should still hold
    // 'production'), then Right Right back to Q3 to submit.
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("left");
    await harness.flush();
    harness.mockInput.pressArrow("left");
    await harness.flush();
    harness.mockInput.pressArrow("right");
    await harness.flush();
    harness.mockInput.pressArrow("right");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    expect(harness.answerCalls[0]!.answers).toEqual({
      "Pick a deployment target": ["production"],
      "Which test suites should run before promotion?": ["integration"],
      "Confirm rollout window": ["now"],
    });
  });

  testIfDocker("Typing a prompt mid-flow flushes accumulated answers", async () => {
    await harness.pushAskTerminal(SINGLE_THEN_MULTI_THEN_SINGLE);
    // Q1: highlight staging (Down once).
    harness.mockInput.pressArrow("down");
    await harness.flush();
    // Right to Q2 (commits 'staging').
    harness.mockInput.pressArrow("right");
    await harness.flush();
    // Q2: toggle e2e via Space (highlight unit, then integration, then e2e).
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressKey(" ");
    await harness.flush();
    // User abandons the picker by typing a free-form prompt and pressing
    // Enter. The submit path should dispatch one `session.answer` carrying
    // both partial answers and the trailing message.
    await harness.mockInput.typeText("actually run a smoke test first");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    const call = harness.answerCalls[0]!;
    expect(call.answers).toEqual({
      "Pick a deployment target": ["staging"],
      "Which test suites should run before promotion?": ["e2e"],
    });
    expect(call.message).toBe("actually run a smoke test first");
    expect(harness.promptCalls).toHaveLength(0);
  });

  testIfDocker("Escape dismisses the picker without dispatching an answer", async () => {
    await harness.pushAskTerminal([SINGLE_THEN_MULTI_THEN_SINGLE[0]!]);
    harness.mockInput.pressArrow("down");
    await harness.flush();
    harness.mockInput.pressEscape();
    await harness.flush();
    // After dismiss, typing + Enter should be a normal prompt — no answer
    // call should happen at all.
    await harness.mockInput.typeText("hello");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt();

    expect(harness.answerCalls).toHaveLength(0);
    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.promptCalls[0]!.message).toBe("hello");
  });

  testIfDocker("Space and Enter type into a non-empty composer instead of advancing", async () => {
    await harness.pushAskTerminal([SINGLE_THEN_MULTI_THEN_SINGLE[0]!]);
    // Type some text first; the picker is open but the composer is non-empty.
    // Space should insert a space, not advance the picker. Enter should
    // submit the typed message (which becomes a prompt-flush of the
    // currently-empty answer set).
    await harness.mockInput.typeText("hi there");
    await harness.flush();
    expect(harness.answerCalls).toHaveLength(0);
    harness.mockInput.pressEnter();
    await harness.waitForAnswer();

    expect(harness.answerCalls).toHaveLength(1);
    expect(harness.answerCalls[0]!.answers).toEqual({});
    expect(harness.answerCalls[0]!.message).toBe("hi there");
  });
});
