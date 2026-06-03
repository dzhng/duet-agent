import { afterEach, beforeEach, describe, expect } from "bun:test";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { HINT_EXIT_CONFIRM } from "../src/tui/theme.js";

/**
 * Ctrl+C is no longer an immediate quit. It is a small state machine whose
 * branch is chosen by the current turn / composer state at press time:
 *
 *   1. running turn   → interrupt it (identical to Esc); no exit prompt.
 *   2. composer text  → clear the composer text only (multiline included);
 *                        attachments / pickers are left untouched.
 *   3. idle + empty   → first press arms a persistent exit confirmation, a
 *                        second press (or Enter) quits; any other key cancels.
 *
 * The exit itself reuses `renderer.destroy()` — the same teardown the old
 * OpenTUI exitOnCtrlC handler used — which the harness surfaces as `exited`.
 */
describe("TUI Ctrl+C exit state machine", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startLongRunningTurn(): Promise<void> {
    await harness.mockInput.typeText("/working 30");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt();
  }

  testIfDocker("Ctrl+C while a turn is running interrupts instead of quitting", async () => {
    await startLongRunningTurn();
    const interruptsBefore = harness.interruptCalls;

    harness.mockInput.pressCtrlC();
    await harness.flush();

    expect(harness.interruptCalls).toBe(interruptsBefore + 1);
    expect(harness.exited).toBe(false);
  });

  testIfDocker("Ctrl+C with text in the composer clears it and stays in the app", async () => {
    await harness.mockInput.typeText("a half-typed thought");
    await harness.flush();
    expect(harness.inputField.plainText).toBe("a half-typed thought");

    harness.mockInput.pressCtrlC();
    await harness.flush();

    expect(harness.inputField.plainText).toBe("");
    expect(harness.exited).toBe(false);
    // Clearing text is not an interrupt and never shows the exit prompt.
    expect(harness.interruptCalls).toBe(0);
    const frame = await harness.captureCharFrame();
    expect(frame).not.toContain(HINT_EXIT_CONFIRM);
  });

  testIfDocker("Ctrl+C clears multiline composer content", async () => {
    await harness.mockInput.typeText("first line");
    await harness.flush();
    harness.mockInput.pressEnter({ shift: true });
    await harness.flush();
    await harness.mockInput.typeText("second line");
    await harness.flush();
    expect(harness.inputField.plainText).toContain("first line");
    expect(harness.inputField.plainText).toContain("second line");

    harness.mockInput.pressCtrlC();
    await harness.flush();

    expect(harness.inputField.plainText).toBe("");
    expect(harness.exited).toBe(false);
  });

  testIfDocker("first Ctrl+C on an idle empty composer arms the exit prompt", async () => {
    harness.mockInput.pressCtrlC();
    await harness.flush();

    const frame = await harness.captureCharFrame();
    expect(frame).toContain(HINT_EXIT_CONFIRM);
    expect(harness.exited).toBe(false);
  });

  testIfDocker("a second Ctrl+C confirms the exit", async () => {
    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(await harness.captureCharFrame()).toContain(HINT_EXIT_CONFIRM);

    harness.mockInput.pressCtrlC();
    await harness.waitForExit();
    expect(harness.exited).toBe(true);
  });

  testIfDocker("Enter confirms the exit while the prompt is showing", async () => {
    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(await harness.captureCharFrame()).toContain(HINT_EXIT_CONFIRM);

    harness.mockInput.pressEnter();
    await harness.waitForExit();
    expect(harness.exited).toBe(true);
  });

  testIfDocker("any other keystroke cancels the prompt and resumes editing", async () => {
    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(await harness.captureCharFrame()).toContain(HINT_EXIT_CONFIRM);

    // A printable key dismisses the prompt and is typed into the composer.
    await harness.mockInput.typeText("h");
    await harness.flush();

    expect(harness.exited).toBe(false);
    expect(harness.inputField.plainText).toBe("h");
    const frame = await harness.captureCharFrame();
    expect(frame).not.toContain(HINT_EXIT_CONFIRM);
  });
});
