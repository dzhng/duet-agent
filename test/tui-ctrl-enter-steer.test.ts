import { afterEach, beforeEach, describe, expect } from "bun:test";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Ctrl+Enter is the dedicated "steer" keybind: dispatch the composer's
 * text via `behavior: "steer"` so the runner injects it at the agent's
 * next inference boundary (rather than at end-of-turn the way Enter-
 * while-running's `follow_up` does). The Enter key now carries three
 * modifier-flavored intents, each tagged by its modifier:
 *
 *   Plain Enter  → submit (idle = fresh turn, running = soft queue)
 *   Shift+Enter  → newline in composer
 *   Ctrl+Enter   → steer (interrupt at next inference boundary, send)
 *
 * Three contract points locked here:
 *
 *  - Ctrl+Enter with non-empty composer dispatches exactly one prompt
 *    call with `behavior: "steer"` and the snapshotted message text.
 *  - Ctrl+Enter with an empty composer and an empty follow-up queue is a
 *    no-op (no prompt, no interrupt, nothing visible).
 *  - Ctrl+Enter with an empty composer and a non-empty follow-up queue
 *    promotes the oldest (front) queued entry into a steer: it is
 *    dequeued and re-dispatched with `behavior: "steer"`, carrying its
 *    own multimodal payload, and only ever one entry per press.
 *  - Ctrl+Enter while idle is a valid send — kicks off a fresh turn
 *    flagged with `behavior: "steer"`, matching the rule that the
 *    keybind is composer-state-agnostic.
 *
 * The modifier is only distinguishable in terminals that speak the
 * kitty-keyboard protocol (the harness enables it); legacy terminals
 * would collapse Ctrl+Enter to plain Enter and dispatch follow_up
 * instead. We accept the same tradeoff we already accepted for
 * Shift+Enter — modern terminals are the target.
 */

describe("TUI Ctrl+Enter steer keystroke", () => {
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

  testIfDocker(
    "Ctrl+Enter with non-empty composer mid-turn dispatches a steer prompt",
    async () => {
      await startLongRunningTurn();
      const promptsBefore = harness.promptCalls.length;

      await harness.mockInput.typeText("redirect to the docs site");
      await harness.flush();
      harness.mockInput.pressEnter({ ctrl: true });
      await harness.waitForPrompt({ count: promptsBefore + 1 });

      expect(harness.promptCalls.length).toBe(promptsBefore + 1);
      const steer = harness.promptCalls[promptsBefore]!;
      expect(steer.message).toBe("redirect to the docs site");
      expect(steer.behavior).toBe("steer");
    },
  );

  testIfDocker("Ctrl+Enter with empty composer and empty queue mid-turn is a no-op", async () => {
    await startLongRunningTurn();
    const promptsBefore = harness.promptCalls.length;

    // Composer is empty after the previous submit and no follow-ups are
    // queued. Pressing Ctrl+Enter here should not dispatch anything; with
    // an empty queue it is neither a send nor an interrupt.
    harness.mockInput.pressEnter({ ctrl: true });
    await harness.flush();
    await harness.flush();

    expect(harness.promptCalls.length).toBe(promptsBefore);
  });

  testIfDocker(
    "Ctrl+Enter with empty composer promotes the oldest queued follow-up as a steer",
    async () => {
      await startLongRunningTurn();
      const promptsBefore = harness.promptCalls.length;

      // Seed a two-entry follow-up queue as if the user had soft-queued two
      // prompts behind the in-flight turn.
      harness.session.editFollowUpQueue({
        prompts: [{ message: "first queued" }, { message: "second queued" }],
      });
      await harness.flush();

      harness.mockInput.pressEnter({ ctrl: true });
      await harness.waitForPrompt({ count: promptsBefore + 1 });

      // Exactly one entry (the oldest) is promoted, delivered as a steer.
      expect(harness.promptCalls.length).toBe(promptsBefore + 1);
      const steer = harness.promptCalls[promptsBefore]!;
      expect(steer.message).toBe("first queued");
      expect(steer.behavior).toBe("steer");

      // The promoted entry is removed from the queue so the runner will not
      // deliver it again; the untouched entry stays queued.
      expect(harness.session.getState()?.followUpQueue).toEqual([{ message: "second queued" }]);
    },
  );

  testIfDocker("Ctrl+Enter promotes the queued follow-up with its own image payload", async () => {
    await startLongRunningTurn();
    const promptsBefore = harness.promptCalls.length;

    const images = [{ data: "ZmFrZQ==", mimeType: "image/png" }];
    harness.session.editFollowUpQueue({
      prompts: [{ message: "queued with image", images }],
    });
    await harness.flush();

    harness.mockInput.pressEnter({ ctrl: true });
    await harness.waitForPrompt({ count: promptsBefore + 1 });

    const steer = harness.promptCalls[promptsBefore]!;
    expect(steer.message).toBe("queued with image");
    expect(steer.behavior).toBe("steer");
    expect(steer.images).toEqual(images);
    expect(harness.session.getState()?.followUpQueue).toEqual([]);
  });

  testIfDocker("Ctrl+Enter promotes only one queued entry per press", async () => {
    await startLongRunningTurn();
    const promptsBefore = harness.promptCalls.length;

    harness.session.editFollowUpQueue({
      prompts: [{ message: "one" }, { message: "two" }, { message: "three" }],
    });
    await harness.flush();

    harness.mockInput.pressEnter({ ctrl: true });
    await harness.waitForPrompt({ count: promptsBefore + 1 });

    expect(harness.promptCalls.length).toBe(promptsBefore + 1);
    expect(harness.promptCalls[promptsBefore]!.message).toBe("one");
    expect(harness.session.getState()?.followUpQueue).toEqual([
      { message: "two" },
      { message: "three" },
    ]);
  });

  testIfDocker(
    "Ctrl+Enter while idle dispatches the composer text as a steer-flagged fresh turn",
    async () => {
      const promptsBefore = harness.promptCalls.length;

      await harness.mockInput.typeText("kick this off as a steer");
      await harness.flush();
      harness.mockInput.pressEnter({ ctrl: true });
      await harness.waitForPrompt({ count: promptsBefore + 1 });

      const steer = harness.promptCalls[promptsBefore]!;
      expect(steer.message).toBe("kick this off as a steer");
      expect(steer.behavior).toBe("steer");
    },
  );
});
