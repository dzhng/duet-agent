import { afterEach, beforeEach, describe, expect } from "bun:test";
import { testIfDocker } from "./helpers/docker-only.js";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { INITIAL_STATE } from "../examples/tui-playground.js";

/**
 * Sidebar context bar: zero-width segments must not reserve layout cells.
 * OpenTUI measures `TextRenderable` with `max(1, contentWidth)`, so an
 * empty sibling still occupies one cell; the bar is one `StyledText`
 * stream instead. Asserts the bracketed interior is only `█`/`░` (25
 * cells) so a stray space from a phantom slot fails the regex.
 */
describe("sidebar context bar", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("zero-token segments do not produce phantom empty cells", async () => {
    // `localMemory: 0` must not insert a gap between non-zero segments.
    const usage = {
      input: 78_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 78_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await harness.pushUsage({
      turnUsage: usage,
      usageByModel: [{ model: "test-model", usage }],
      lastMessageUsage: usage,
      effectiveContextWindow: 200_000,
      contextWindowUsage: {
        systemPrompt: 5_000,
        messages: 30_000,
        localMemory: 0,
        globalMemory: 10_000,
      },
    });
    await harness.flush();

    // Bar interior is exactly `CONTEXT_BAR_WIDTH` (25) cells of `█`
    // and `░` glyphs sandwiched between `[` and `]`. A phantom 1-cell
    // slot from an empty TextRenderable would surface as a space (or
    // any non-glyph character) inside the brackets, breaking the
    // all-glyph match. The capture frame includes ANSI escape noise
    // outside the rendered cells, so we extract the bracket-bounded
    // glyph run directly rather than slicing by line.
    const frame = await harness.captureCharFrame();
    const match = frame.match(/\[([\u2588\u2591]+)\]/);
    expect(match).toBeDefined();
    expect(match![1]).toHaveLength(25);

    // The bar must show at least one filled cell — anything else means
    // the push did not propagate through Runner → Session → TUI →
    // sidebar (the placeholder is all `░`). Filled cells then proves
    // the contiguity invariant: every filled segment renders next to
    // every other filled segment with no `░` interleaved.
    expect(match![1]).toContain("\u2588");
    expect(match![1]).toMatch(/^\u2588+\u2591*$/);
  });

  testIfDocker("an all-zero breakdown still renders a full-width empty bar", async () => {
    // Before usage is reported the sidebar paints `░` × CONTEXT_BAR_WIDTH;
    // pushing an explicit all-zero breakdown should match that initial
    // state rather than collapsing to nothing or leaving phantom cells.
    const zero = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await harness.pushUsage({
      turnUsage: zero,
      usageByModel: [{ model: "test-model", usage: zero }],
      lastMessageUsage: zero,
      effectiveContextWindow: 200_000,
      contextWindowUsage: {
        systemPrompt: 0,
        messages: 0,
        localMemory: 0,
        globalMemory: 0,
      },
    });
    await harness.flush();

    const frame = await harness.captureCharFrame();
    const match = frame.match(/\[([\u2588\u2591]+)\]/);
    expect(match).toBeDefined();
    expect(match![1]).toBe("\u2591".repeat(25));
  });

  testIfDocker(
    "task-origin usage attributes only its delta while the context bar stays parent-scoped",
    async () => {
      await harness.dispose();
      harness = await bootTui({
        initialState: {
          ...INITIAL_STATE,
          tasks: [
            {
              id: "t4",
              kind: "subagent",
              name: "spawn_agent",
              label: "audit auth flows",
              ownerScopeId: "turn-1",
              status: "running",
              startedAt: Date.now() - 5_000,
            },
          ],
        },
      });
      const parentUsage = tokenUsage(10_000, 0.1);
      await harness.pushUsage({
        turnUsage: parentUsage,
        usageByModel: [{ model: "parent", usage: parentUsage }],
        lastMessageUsage: parentUsage,
        effectiveContextWindow: 200_000,
        contextWindowUsage: {
          systemPrompt: 2_000,
          messages: 8_000,
          localMemory: 0,
          globalMemory: 0,
        },
      });
      const aggregate = tokenUsage(78_000, 0.78);
      const parentContext = tokenUsage(45_000, 0.1);
      await harness.pushUsage({
        origin: { kind: "task", taskId: "t4", ownerScopeId: "turn-1" },
        turnUsage: aggregate,
        usageByModel: [
          { model: "parent", usage: parentUsage },
          { model: "child", usage: tokenUsage(68_000, 0.68) },
        ],
        lastMessageUsage: parentContext,
        effectiveContextWindow: 200_000,
        contextWindowUsage: {
          systemPrompt: 5_000,
          messages: 40_000,
          localMemory: 0,
          globalMemory: 0,
        },
      });

      const frame = await harness.captureCharFrame();
      expect(frame).toContain("45k / 200k");
      expect(frame).toContain("[68.0k tok]");
      expect(frame).toContain("$0.7800");
    },
  );
});

function tokenUsage(totalTokens: number, costTotal: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: costTotal,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costTotal,
    },
  };
}
