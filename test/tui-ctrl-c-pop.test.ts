import { afterEach, beforeEach, describe, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";
import type { TurnPromptImage } from "../src/types/protocol.js";

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

const TINY_PNG: TurnPromptImage = {
  data: Buffer.from(PNG_HEADER).toString("base64"),
  mimeType: "image/png",
};

function makePngFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `duet-tui-ctrl-c-pop-${prefix}-`));
  const file = join(dir, `${prefix}.png`);
  writeFileSync(file, PNG_HEADER);
  return file;
}

describe("TUI Ctrl+C pops queued follow-up", () => {
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

  function queuedMessages(): string[] {
    return (harness.session.getState()?.followUpQueue ?? []).map((entry) => entry.message);
  }

  testIfDocker(
    "Ctrl+C with empty composer pops the newest queued entry without interrupting",
    async () => {
      await startLongRunningTurn();
      harness.session.editFollowUpQueue({
        prompts: [{ message: "first thought" }, { message: "second thought" }],
      });
      await harness.flush();
      expect(harness.inputField.plainText).toBe("");

      harness.mockInput.pressCtrlC();
      await harness.flush();

      expect(harness.inputField.plainText).toBe("second thought");
      expect(queuedMessages()).toEqual(["first thought"]);
      expect(harness.interruptCalls).toBe(0);
      expect(harness.exited).toBe(false);
    },
  );

  testIfDocker(
    "repeated Ctrl+C pops only one entry; the next press hits the unchanged branch",
    async () => {
      await startLongRunningTurn();
      harness.session.editFollowUpQueue({
        prompts: [{ message: "first thought" }, { message: "second thought" }],
      });
      await harness.flush();

      harness.mockInput.pressCtrlC();
      await harness.flush();
      expect(harness.inputField.plainText).toBe("second thought");
      expect(harness.interruptCalls).toBe(0);

      harness.mockInput.pressCtrlC();
      await harness.flush();
      expect(queuedMessages()).toEqual(["first thought"]);
      expect(harness.interruptCalls).toBe(1);
    },
  );

  testIfDocker("Ctrl+C with text already in the composer does not pop", async () => {
    await startLongRunningTurn();
    harness.session.editFollowUpQueue({ prompts: [{ message: "queued entry" }] });
    await harness.flush();

    await harness.mockInput.typeText("half-typed");
    await harness.flush();
    expect(harness.inputField.plainText).toBe("half-typed");

    harness.mockInput.pressCtrlC();
    await harness.flush();

    expect(queuedMessages()).toEqual(["queued entry"]);
    expect(harness.interruptCalls).toBe(1);
  });

  testIfDocker("Ctrl+C with only local attachments does not pop", async () => {
    await startLongRunningTurn();
    harness.session.editFollowUpQueue({ prompts: [{ message: "queued entry" }] });
    await harness.flush();

    await harness.mockInput.typeText(`/image ${makePngFixture("pending")}`);
    harness.mockInput.pressEnter();
    await harness.flush();
    harness.inputField.clear();
    await harness.flush();

    harness.mockInput.pressCtrlC();
    await harness.flush();

    expect(queuedMessages()).toEqual(["queued entry"]);
    expect(harness.interruptCalls).toBe(1);
  });

  testIfDocker("a popped entry is not rendered as a delivered you: block", async () => {
    await startLongRunningTurn();
    harness.session.editFollowUpQueue({ prompts: [{ message: "popme-marker" }] });
    await harness.flush();

    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(harness.inputField.plainText).toBe("popme-marker");
    expect(queuedMessages()).toEqual([]);

    harness.inputField.clear();
    await harness.flush();
    expect(harness.inputField.plainText).toBe("");

    const frame = await harness.captureCharFrame();
    expect(frame).not.toContain("popme-marker");
  });

  testIfDocker("popped image attachments are forwarded on resubmit", async () => {
    await startLongRunningTurn();
    harness.session.editFollowUpQueue({
      prompts: [{ message: "describe [Image #1]", images: [TINY_PNG] }],
    });
    await harness.flush();

    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(harness.inputField.plainText).toBe("describe [Image #1]");

    harness.mockInput.pressEnter();
    await harness.flush();

    expect(harness.promptCalls.at(-1)).toMatchObject({
      message: "describe [Image #1]",
      behavior: "follow_up",
      images: [TINY_PNG],
    });
  });

  testIfDocker("pop suppression matches duplicate text by attachment payload", async () => {
    const otherPng = { ...TINY_PNG, data: Buffer.from("other").toString("base64") };
    await startLongRunningTurn();
    harness.session.editFollowUpQueue({
      prompts: [
        { message: "same text", images: [TINY_PNG] },
        { message: "same text", images: [otherPng] },
      ],
    });
    await harness.flush();

    harness.mockInput.pressCtrlC();
    await harness.flush();
    expect(queuedMessages()).toEqual(["same text"]);

    harness.session.editFollowUpQueue({ prompts: [] });
    await harness.flush();
    harness.inputField.clear();
    await harness.flush();

    const frame = await harness.captureCharFrame();
    expect(frame).toContain("same text");
  });
});
