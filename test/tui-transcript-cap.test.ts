import { describe, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { buildLayout } from "../src/tui/layout.js";
import { COLORS } from "../src/tui/theme.js";
import { TranscriptWriter } from "../src/tui/transcript-writer.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Regression coverage for the v0.1.171 long-transcript scroll freeze.
 *
 * Root cause: the transcript ScrollBox kept one renderable per line with no
 * bound, and OpenTUI runs a full Yoga layout pass over every child each
 * frame. Once the tree grew to thousands of nodes a single append/render
 * cost ~1s, starving the event loop so mouse-wheel scroll stopped reacting —
 * and because a resumed session replays the whole transcript, it was frozen
 * from the first frame. `TranscriptWriter` now caps the live node count by
 * evicting the oldest renderables while pinned to the bottom.
 *
 * These tests assert the policy, not timing: node count stays bounded under
 * heavy bottom-pinned streaming, and eviction pauses while the user has
 * scrolled up so history they are reading is never yanked out from under them.
 */
describe("transcript renderable cap", () => {
  // Mirrors MAX_TRANSCRIPT_RENDERABLES in transcript-writer.ts; the constant
  // is intentionally private, so we assert against the same generous bound.
  const CAP = 1500;

  testIfDocker("bottom-pinned streaming caps live renderables", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 120,
      height: 40,
      kittyKeyboard: true,
    });
    const ui = buildLayout(renderer);
    const writer = new TranscriptWriter(renderer, ui.transcript, {
      getLastSelectionText: () => "",
    });

    // Stream far past the cap through the production append path. Render
    // periodically like a real turn so sticky-bottom geometry stays current.
    for (let i = 0; i < 8000; i++) {
      writer.appendBlock(null, `agent line ${i} the quick brown fox jumps`, COLORS.agent);
      if (i % 500 === 0) await renderOnce();
    }
    await renderOnce();

    expect(ui.transcript.getChildren().length).toBeLessThanOrEqual(CAP);
    renderer.destroy();
  });

  testIfDocker("eviction pauses while scrolled up so history is not yanked", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 120,
      height: 40,
      kittyKeyboard: true,
    });
    const ui = buildLayout(renderer);
    const writer = new TranscriptWriter(renderer, ui.transcript, {
      getLastSelectionText: () => "",
    });

    // Fill to the cap while pinned to the bottom.
    for (let i = 0; i < CAP; i++) {
      writer.appendBlock(null, `line ${i}`, COLORS.agent);
      if (i % 500 === 0) await renderOnce();
    }
    await renderOnce();
    const atCap = ui.transcript.getChildren().length;
    expect(atCap).toBeLessThanOrEqual(CAP);

    // Scroll up to read history, then append more. Eviction must not trim
    // while scrolled away from the bottom, so the node count exceeds the cap
    // rather than removing the lines the user is reading.
    ui.transcript.scrollTop = 0;
    await renderOnce();
    for (let i = 0; i < 600; i++) {
      writer.appendBlock(null, `more ${i}`, COLORS.agent);
    }
    await renderOnce();

    expect(ui.transcript.getChildren().length).toBeGreaterThan(CAP);
    renderer.destroy();
  });
});
