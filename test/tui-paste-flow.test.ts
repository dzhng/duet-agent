import { afterEach, beforeEach, describe, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { PasteEvent } from "@opentui/core";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Bracketed-paste and binary-clipboard plumbing wired through the real
 * `runTui` paste handler. Each test drives `inputField.onPaste` either via
 * `mockInput.pasteBracketedText` (the actual terminal bytes path) or a
 * directly-constructed `PasteEvent` for the binary case, which the
 * bracketed-paste parser cannot synthesize on its own.
 */

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

describe("TUI paste flow", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker(
    "file:// URL paste resolves to an image attachment with the correct base64",
    async () => {
      // Seed a real PNG on disk so `loadImageFromPath` can sniff bytes and
      // produce an attachment payload identical to the on-disk content.
      const dir = mkdtempSync(join(tmpdir(), "duet-tui-paste-file-"));
      const file = join(dir, "cat.png");
      writeFileSync(file, PNG_HEADER);

      await harness.mockInput.pasteBracketedText(`file://${file}`);
      // attachImageFromPath is async; poll until [Image #1] surfaces in the
      // composer so we know the load actually resolved before assertions.
      const start = Date.now();
      while (!harness.inputField.plainText.includes("[Image #1]") && Date.now() - start < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(harness.inputField.plainText).toContain("[Image #1]");

      // Hint advertises the queued attachment to the user.
      const hintFrame = await harness.captureCharFrame();
      expect(hintFrame).toContain("\u{1F4CE} 1 image attached");

      // Submit consumes the queue and forwards the attachment to the
      // runner. Asserting on the base64 round-trip catches any encoding
      // drift between disk \u2192 attachment \u2192 wire format.
      await harness.mockInput.typeText(" describe");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      expect(harness.promptCalls).toHaveLength(1);
      expect(harness.promptCalls[0]!.images).toHaveLength(1);
      expect(harness.promptCalls[0]!.images![0]!.mimeType).toBe("image/png");
      expect(harness.promptCalls[0]!.images![0]!.data).toBe(
        Buffer.from(PNG_HEADER).toString("base64"),
      );
    },
  );

  testIfDocker(
    "plain-text paste falls through to the textarea insert and skips the attachment surface",
    async () => {
      const payload = "snippet pasted from the docs";
      await harness.mockInput.pasteBracketedText(payload);
      await harness.flush();
      await harness.flush();

      // Text appended to the composer.
      expect(harness.inputField.plainText).toContain(payload);
      // No attachment hint segment surfaces because no image was queued.
      const frame = await harness.captureCharFrame();
      expect(frame).not.toContain("\u{1F4CE}");
    },
  );

  testIfDocker(
    "binary-metadata paste with non-image bytes surfaces the unsupported diagnostic",
    async () => {
      // The bracketed-paste parser never sets `metadata.kind: \"binary\"`, so
      // we exercise the unsupported-binary branch by handing `onPaste` a
      // hand-rolled `PasteEvent` with the right metadata. The harness pulls
      // the production `onPaste` handler off the input field, which is the
      // same callback `runTui` wires up.
      const before = harness.inputField.plainText;
      const randomBytes = Uint8Array.from([0x42, 0x10, 0xff, 0x01, 0x7f, 0x00, 0x33, 0x99]);
      const event = new PasteEvent(randomBytes, { kind: "binary" });
      harness.inputField.onPaste?.(event);
      await harness.flush();
      await harness.flush();

      // Composer must be untouched (the handler called `preventDefault`).
      expect(harness.inputField.plainText).toBe(before);
      const frame = await harness.captureCharFrame();
      expect(frame).toContain("Unsupported binary clipboard contents");
    },
  );
});
