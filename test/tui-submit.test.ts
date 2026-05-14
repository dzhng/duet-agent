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

  testIfDocker(
    "Enter mid-turn suppresses the transcript `you:` block until the runner drains the queue",
    async () => {
      // Pins the queue-time suppression invariant from `dispatchTurn`:
      // when a follow-up is dispatched while a turn is already running,
      // the message must reach `session.prompt` but must NOT be painted
      // into the transcript as a `you:` block at submit time. The
      // follow-up panel above the compose row owns surfacing the queued
      // text; the transcript only gets the block when the runner later
      // hands the entry to the agent (covered by the drain replay test).
      await harness.mockInput.typeText("/working 30");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      const distinctive = "queued-but-not-rendered-yet";
      await harness.mockInput.typeText(distinctive);
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt({ count: 2 });

      // The session received the prompt with the expected behavior…
      expect(harness.promptCalls).toHaveLength(2);
      expect(harness.promptCalls[1]!.message).toBe(distinctive);
      expect(harness.promptCalls[1]!.behavior).toBe("follow_up");

      // …but the transcript must not contain a `you:` block for it yet.
      // The string is distinctive enough that any occurrence in the
      // captured frame would have to come from a rendered transcript
      // block, not from chrome text.
      const frame = await harness.captureCharFrame();
      expect(frame).not.toContain(distinctive);
    },
  );

  testIfDocker(
    "Runner draining the follow-up queue replays the suppressed `you:` block into the transcript",
    async () => {
      // Pins the drain-time replay invariant from `bindSessionToUi`:
      // when a `follow_up_queue` event removes an entry that was present
      // in the prior snapshot, the session subscription must render the
      // delivered entry as a `you:` transcript block. This is the
      // counterpart to the queue-time suppression above; together they
      // guarantee every queued follow-up shows up exactly once, at the
      // moment the runner actually consumes it.
      await harness.mockInput.typeText("/working 30");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      const distinctive = "drained-into-transcript";
      await harness.mockInput.typeText(distinctive);
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt({ count: 2 });

      let frame = await harness.captureCharFrame();
      expect(frame).not.toContain(distinctive);

      // Drive the queue lifecycle by hand: first surface the entry as
      // queued, then drain it. The diff between the two snapshots is
      // what the subscription uses to decide what to replay.
      harness.runner.emitEvent({
        type: "follow_up_queue",
        prompts: [{ message: distinctive }],
      });
      await harness.flush();
      harness.runner.emitEvent({ type: "follow_up_queue", prompts: [] });
      await harness.flush();

      frame = await harness.captureCharFrame();
      expect(frame).toContain(distinctive);
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
      // session.interrupt is async; give it a tick to resolve. The textarea
      // hook claims the keystroke (preventDefault + escapeState.suppress) so
      // the renderer-level global handler skips the duplicate dispatch and
      // exactly one interrupt lands per Esc press.
      await harness.flush();
      await harness.flush();
      expect(harness.interruptCalls).toBe(1);
    },
  );
});
