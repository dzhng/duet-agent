import { afterEach, beforeEach, describe, expect } from "bun:test";
import { testIfDocker } from "./helpers/docker-only.js";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";

/**
 * On a fresh session the three runtime sidebar panels (`todos`,
 * `follow-ups`, `loops`) are empty. The placeholder copy must teach the
 * user what each panel is for instead of showing opaque `(none)` /
 * `(inactive)` markers — a brand-new user has no other way to learn that
 * Shift+Enter queues a follow-up or that long-running prompts open loops.
 *
 * This test would have failed before the empty-state hint refactor, when
 * `setTodos([])` / `setFollowUpQueue([])` / `setStateMachine(undefined)`
 * wrote literal `"(none)"` / `"(inactive)"` into the panel bodies.
 */
describe("sidebar empty-state hints", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("empty panels render educational copy instead of (none) / (inactive)", async () => {
    // The harness's bootstrap submit already triggered a session subscriber
    // refresh, which called setTodos([]) / setFollowUpQueue([]) /
    // setStateMachine(undefined). The captured frame reflects post-refresh
    // state, so any regression that restores `(none)` / `(inactive)` shows
    // up here.
    const frame = await harness.captureCharFrame();

    // No placeholder markers anywhere in the rendered frame. Catching both
    // strings guards against a partial revert that touches only one panel.
    expect(frame).not.toContain("(none)");
    expect(frame).not.toContain("(inactive)");

    // Each panel renders a distinctive substring from its hint copy.
    // Substrings are chosen to survive the panel's word-wrap inside the
    // 32-cell inner width — they appear as a contiguous run on a single
    // wrapped row of the rendered frame.
    expect(frame).toContain("in-turn checklist"); // todos hint
    expect(frame).toContain("queues a message here"); // follow-ups hint
    expect(frame).toContain("No loop running."); // loops hint
  });
});
