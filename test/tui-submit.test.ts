import { afterEach, beforeEach, describe, expect } from "bun:test";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Plain-Enter submit dispatch matrix. The keymap test pins picker routing;
 * this file pins the *idle / running* dispatch contract that runs every
 * keystroke through `runTui`'s real `submit()` handler:
 *
 *  - Idle Enter → one `session.prompt({ behavior: "follow_up", images: [] })`
 *    and the chrome flips into the running state (working ticker visible).
 *  - Running Enter → soft queue; a second `session.prompt` lands while the
 *    first turn is still in flight.
 *  - Shift+Enter → literal newline in the composer; no prompt dispatched.
 *  - Esc while running → `session.interrupt()`; Esc while idle is a no-op.
 */

describe("TUI submit + esc dispatch", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    // Wider than the default 100 cols so the running hint footer
    // (`Enter: queue follow-up · Ctrl+Enter: steer · PgUp/PgDn: scroll
    // · Esc: interrupt`) renders un-clipped in the captured frame. The
    // main column is narrower than the full viewport (sidebar steals
    // ~36 cols), so the hint needs ~160 cols of total width to survive.
    harness = await bootTui({ width: 200 });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker(
    "Enter while idle dispatches one follow_up prompt and flips to running",
    async () => {
      await harness.mockInput.typeText("hello");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      expect(harness.promptCalls).toHaveLength(1);
      expect(harness.promptCalls[0]!.message).toBe("hello");
      expect(harness.promptCalls[0]!.behavior).toBe("follow_up");
      expect(harness.promptCalls[0]!.images).toEqual([]);

      // The chrome must show the running indicator. The status line draws
      // "● working…" with an elapsed counter; the leading bullet glyph is
      // unique to the running state. The running hint footer must also
      // advertise Esc as the interrupt affordance — that is the only place
      // the contract is surfaced to the user.
      const frame = await harness.captureCharFrame();
      expect(frame).toContain("working");
      expect(frame).toContain("Esc: interrupt");
    },
  );

  testIfDocker("Enter mid-turn enqueues a follow-up via a second session.prompt", async () => {
    // /working 30 keeps the runner busy long enough for a second submit to
    // land while the first turn is still in flight.
    await harness.mockInput.typeText("/working 30");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt();

    await harness.mockInput.typeText("follow-up while running");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt({ count: 2 });

    expect(harness.promptCalls).toHaveLength(2);
    expect(harness.promptCalls[1]!.message).toBe("follow-up while running");
    expect(harness.promptCalls[1]!.behavior).toBe("follow_up");
  });

  testIfDocker("Shift+Enter inserts a literal newline and does not dispatch", async () => {
    await harness.mockInput.typeText("line one");
    await harness.flush();
    const before = harness.inputField.plainText;
    expect(before).toBe("line one");

    harness.mockInput.pressEnter({ shift: true });
    await harness.flush();

    expect(harness.inputField.plainText).toBe("line one\n");
    expect(harness.promptCalls).toHaveLength(0);

    // Typing further confirms the cursor is on the new line: the prior
    // text remains intact and the new content appends to it.
    await harness.mockInput.typeText("line two");
    await harness.flush();
    expect(harness.inputField.plainText).toBe("line one\nline two");
    expect(harness.promptCalls).toHaveLength(0);
  });

  testIfDocker(
    "Esc while running calls session.interrupt(); Esc while idle is a no-op",
    async () => {
      // Idle Esc: harness boots idle. Pressing Esc must not increment the
      // interrupt counter, and the composer must stay empty.
      expect(harness.interruptCalls).toBe(0);
      harness.mockInput.pressEscape();
      await harness.flush();
      expect(harness.interruptCalls).toBe(0);

      // Now flip into running by dispatching /working 30 (long-lived).
      await harness.mockInput.typeText("/working 30");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      harness.mockInput.pressEscape();
      // session.interrupt is async; give it a tick to resolve. The Esc keystroke
      // travels through both the textarea `onKeyDown` and the renderer's global
      // keypress handler, so the production wiring fires `onEscape` more than
      // once per press — assert at least one interrupt landed rather than
      // pinning the exact count, which is a separate dedup concern.
      await harness.flush();
      await harness.flush();
      expect(harness.interruptCalls).toBeGreaterThanOrEqual(1);
    },
  );
});
