import { afterEach, beforeEach, describe, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Built-in slash commands intercepted at submit time. Each one must:
 *
 *  - claim the message (no `session.prompt` is dispatched),
 *  - leave a visible side effect in the rendered frame, and
 *  - keep the composer + attachment surface in a sensible post-state.
 */

// Minimal PNG header bytes; `sniffImageMimeType` recognises the eight-byte
// magic prefix, which is all that downstream `/image` and `/clear-images`
// machinery cares about \u2014 we never decode the pixels.
const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

function makePngFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `duet-tui-slash-${prefix}-`));
  const file = join(dir, `${prefix}.png`);
  writeFileSync(file, PNG_HEADER);
  return file;
}

describe("TUI slash commands", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("/clear-images drops queued attachments and never dispatches a prompt", async () => {
    // Attach two real fixtures via the `/image` slash command so the
    // attachment queue is non-empty before we run /clear-images.
    const firstPng = makePngFixture("first");
    const secondPng = makePngFixture("second");

    await harness.mockInput.typeText(`/image ${firstPng}`);
    await harness.flush();
    harness.mockInput.pressEnter();
    // attachImageFromPath is async; poll until the [Image #1] placeholder
    // surfaces in the composer.
    const start = Date.now();
    while (!harness.inputField.plainText.includes("[Image #1]") && Date.now() - start < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(harness.inputField.plainText).toContain("[Image #1]");

    // After the first /image succeeds the composer holds `[Image #1]`;
    // clear it before sending the next slash command so the second submit
    // is parsed as a fresh `/image` and not as a literal message body.
    harness.inputField.clear();
    await harness.mockInput.typeText(`/image ${secondPng}`);
    await harness.flush();
    harness.mockInput.pressEnter();
    const start2 = Date.now();
    while (!harness.inputField.plainText.includes("[Image #2]") && Date.now() - start2 < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(harness.inputField.plainText).toContain("[Image #2]");

    // Hint row should now advertise the queued attachments. The exact count
    // glyph is `\u{1F4CE}` followed by `2 images attached`.
    let frame = await harness.captureCharFrame();
    expect(frame).toContain("\u{1F4CE} 2 images attached");

    // Clear queue + composer, then run /clear-images. The handler returns
    // true from the slash dispatcher so no session.prompt fires.
    harness.inputField.clear();
    await harness.flush();
    await harness.mockInput.typeText("/clear-images");
    await harness.flush();
    // Close the autocomplete picker so the next Enter triggers `submit`
    // instead of completing the highlighted row.
    harness.mockInput.pressEscape();
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.flush();
    await harness.flush();

    expect(harness.promptCalls).toHaveLength(0);
    frame = await harness.captureCharFrame();
    // Attachment hint segment must be gone after /clear-images.
    expect(frame).not.toContain("\u{1F4CE} 2 images attached");
    expect(frame).not.toContain("\u{1F4CE} 1 image attached");
  });

  testIfDocker("/copy last surfaces a [copy] transcript block and dispatches no prompt", async () => {
    // Stream an agent reply through /echo so the transcript log has an
    // assistant entry for `selectCopyText("last")` to pick up.
    await harness.mockInput.typeText("/echo hellofromrunner");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt();
    await harness.waitForTerminal();
    await harness.flush();

    const promptsBefore = harness.promptCalls.length;
    await harness.mockInput.typeText("/copy last");
    await harness.flush();
    harness.mockInput.pressEnter();
    // Clipboard write resolves asynchronously (CLI probe + readback); poll
    // until the [copy] line lands in the frame.
    const start = Date.now();
    let frame = await harness.captureCharFrame();
    while (!frame.includes("[copy]") && Date.now() - start < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      frame = await harness.captureCharFrame();
    }
    expect(frame).toContain("[copy]");
    // /copy is a local slash command \u2014 it must never reach the runner.
    expect(harness.promptCalls.length).toBe(promptsBefore);
  });

  testIfDocker("/diag toggles diagnostics so the next keypress appends a [diag] block", async () => {
    // Diagnostics start off; pressing a regular character beforehand must
    // not log anything. After /diag flips them on, the next keystroke
    // produces a [diag] transcript block.
    // Trailing space closes the slash autocomplete picker so the next Enter
    // fires `submit("/diag ")` instead of completing the highlighted row.
    await harness.mockInput.typeText("/diag ");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.flush();

    let frame = await harness.captureCharFrame();
    // The slash handler itself appends a [diag] confirmation block
    // explaining how to turn logging off again.
    expect(frame).toContain("[diag]");
    expect(frame).toMatch(/key \+ selection event logging ON/);

    // With logging on, any keystroke now routes through `logKey` which
    // appends a new [diag] line. Type an arbitrary letter and confirm a
    // fresh entry surfaces (the "name=" prefix is part of the dump).
    await harness.mockInput.typeText("z");
    await harness.flush();
    frame = await harness.captureCharFrame();
    expect(frame).toContain('name="z"');
  });

  testIfDocker("/image <abs-path> inserts a placeholder and submit forwards the attachment", async () => {
    const png = makePngFixture("attach");
    await harness.mockInput.typeText(`/image ${png}`);
    await harness.flush();
    harness.mockInput.pressEnter();
    const start = Date.now();
    while (!harness.inputField.plainText.includes("[Image #1]") && Date.now() - start < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(harness.inputField.plainText).toContain("[Image #1]");
    // /image is local \u2014 no prompt yet.
    expect(harness.promptCalls).toHaveLength(0);

    // Submit a real prompt: the attachment must be drained and forwarded.
    await harness.mockInput.typeText(" describe this image");
    await harness.flush();
    harness.mockInput.pressEnter();
    await harness.waitForPrompt();

    expect(harness.promptCalls).toHaveLength(1);
    expect(harness.promptCalls[0]!.images).toHaveLength(1);
    expect(harness.promptCalls[0]!.images![0]!.mimeType).toBe("image/png");
    // The base64 payload must round-trip the PNG header bytes verbatim so
    // the runner sees exactly what we put on disk.
    expect(harness.promptCalls[0]!.images![0]!.data).toBe(
      Buffer.from(PNG_HEADER).toString("base64"),
    );
  });
});
