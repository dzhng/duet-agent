import { afterEach, beforeEach, describe, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Autocomplete pickers. The pure ranking helpers
 * (`skillAutocompleteMatches`, `fileAutocompleteMatches`,
 * `replaceFileAutocompleteToken`) are unit-tested elsewhere; this file
 * locks the *visible* picker contract:
 *
 *  - `/` opens the slash picker with a "commands" header.
 *  - `/cl` narrows to both `/clear` and `/clear-images` (built-in prefix
 *    match — both commands share the `cl` prefix after the rename).
 *  - Tab completes the highlighted row into the composer.
 *  - Esc closes the picker without exiting the TUI.
 *  - `@` opens the file picker against a seeded `workDir` fixture and Tab
 *    inserts a markdown link of the form `[@<basename>](./<relative>) ` \u2014
 *    the production invariant locked by the preface commit.
 */

describe("TUI autocomplete pickers", () => {
  let harness: TuiHarness;

  afterEach(async () => {
    await harness.dispose();
  });

  describe("slash picker", () => {
    beforeEach(async () => {
      harness = await bootTui();
    });

    testIfDocker("typing `/` opens the picker with the commands header visible", async () => {
      await harness.mockInput.typeText("/");
      await harness.flush();

      const frame = await harness.captureCharFrame();
      // "commands" header sits above the slash rows; built-in commands are
      // always shown when the query is empty.
      expect(frame).toContain("commands");
      // At least one well-known built-in should be visible \u2014 use
      // `/clear-images` since its dashed name is unambiguous in the frame.
      expect(frame).toContain("/clear-images");
    });

    testIfDocker("typing `/cl` narrows the picker to `clear` and `clear-images`", async () => {
      await harness.mockInput.typeText("/cl");
      await harness.flush();

      const frame = await harness.captureCharFrame();
      // After the `/reset` → `/clear` rename, `/cl` matches BOTH `/clear` and
      // `/clear-images`. The narrowed picker must show both and must not show
      // other built-ins whose names do not start with `cl` (e.g. `/image`,
      // `/diag`, `/feedback`).
      expect(frame).toContain("/clear");
      expect(frame).toContain("/clear-images");
      expect(frame).not.toContain("/image\n");
      expect(frame).not.toContain("/diag");
      expect(frame).not.toContain("/feedback");
    });

    testIfDocker("Tab completes the highlighted slash row into the composer", async () => {
      // Use `/pa`, whose first letter `p` is unique among the built-in
      // commands, so it resolves to exactly `/paste`. A unique-first-letter
      // command avoids the `/clear` vs `/clear-images` shared-prefix ambiguity
      // (any prefix of `clear` matches both, and `clear` sorts first) and stays
      // robust even if a partial flush settles only the first typed char.
      await harness.mockInput.typeText("/pa");
      await harness.flush();
      // Picker auto-highlights the first match; Tab inserts the full name.
      harness.mockInput.pressTab();
      await harness.flush();

      expect(harness.inputField.plainText).toBe("/paste ");
      // Picker must close after completion so the next Enter submits.
      const frame = await harness.captureCharFrame();
      expect(frame).not.toContain("commands");
    });

    testIfDocker("Esc closes the picker without tearing down the TUI", async () => {
      await harness.mockInput.typeText("/");
      await harness.flush();
      let frame = await harness.captureCharFrame();
      expect(frame).toContain("commands");

      harness.mockInput.pressEscape();
      await harness.flush();
      frame = await harness.captureCharFrame();
      // After Esc, the picker header is gone and the composer is intact.
      expect(frame).not.toContain("commands");
      expect(harness.inputField.plainText).toBe("/");
      // No prompt was dispatched on Esc.
      expect(harness.promptCalls).toHaveLength(0);
    });
  });

  describe("@-file picker", () => {
    let fixtureDir: string;

    beforeEach(async () => {
      // Seed a fresh temp workDir with a known file so the @-picker has a
      // deterministic match regardless of the host repo layout. The fixture
      // basename `widget.ts` is picked specifically because no other path
      // in this temp dir starts with `w`, making the prefix match unique.
      fixtureDir = mkdtempSync(join(tmpdir(), "duet-tui-at-"));
      writeFileSync(join(fixtureDir, "widget.ts"), "export const W = 1;\n");
      harness = await bootTui({ workDir: fixtureDir });
    });

    testIfDocker(
      "typing `@` shows the file panel; Tab inserts `[@basename](./relative/path) `",
      async () => {
        // The file index loads lazily on first `@`; poll the captured frame
        // until the fixture basename surfaces so the test stays robust
        // against the underlying `readdir` latency.
        await harness.mockInput.typeText("@");
        await harness.flush();
        const start = Date.now();
        let frame = await harness.captureCharFrame();
        while (!frame.includes("widget.ts") && Date.now() - start < 1500) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          frame = await harness.captureCharFrame();
        }
        expect(frame).toContain("widget.ts");

        // Tab inserts the markdown-link form. The trailing space is part of
        // the production contract \u2014 absent it, chained `@`-mentions
        // would collide on the next keystroke.
        harness.mockInput.pressTab();
        await harness.flush();
        expect(harness.inputField.plainText).toBe("[@widget.ts](./widget.ts) ");
      },
    );
  });
});
