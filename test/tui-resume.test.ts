import { describe, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestRenderer } from "@opentui/core/testing";

import { runTui } from "../src/tui/app.js";
import { Session } from "../src/session/session.js";
import { FakePlaygroundRunner } from "../examples/tui-playground.js";
import { createUpgradeStatusStream } from "../src/cli/auto-upgrade.js";
import { testIfDocker } from "./helpers/docker-only.js";

// Drain microtasks twice so keystroke events fed through `mockInput` have
// time to update the input field, fire `onContentChange`, and flush the
// renderer. One tick is enough on macOS; Linux Docker needs both.
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Architectural contract: `--resume <id>` invocations skip the boot starter
// menu entirely. The user explicitly asked to drop back into a known
// conversation, so showing "what should we work on today?" or
// "pick up the thread" before replaying transcript history is noise that
// regressed earlier and we want test-locked.
//
// Companion contract: on a fresh boot (no resume), the chrome must hide as
// soon as the user types and come back if they backspace the composer empty
// again — until they actually commit a prompt, after which it stays gone.

async function bootStarterTui(options: { isResume: boolean }) {
  const { renderer, mockInput, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 32,
    kittyKeyboard: true,
  });

  const sessionPath = await mkdtemp(join(tmpdir(), "duet-resume-test-"));
  const runner = new FakePlaygroundRunner();
  const session = new Session(
    { model: "harness", cwd: process.cwd() },
    { id: "harness", sessionPath, runner, resumeFromStorage: false },
  );

  const upgradeStatus$ = createUpgradeStatusStream();
  upgradeStatus$.complete({ kind: "skipped", reason: "disabled" });

  const tuiPromise = runTui({
    session,
    workDir: process.cwd(),
    sessionId: "harness",
    packageName: "@duetso/agent",
    packageVersion: "harness",
    modelName: "harness",
    memoryModelName: "harness",
    upgradeStatus$,
    renderer,
    ...(options.isResume ? { isResume: true } : {}),
  }).catch(() => undefined);

  // Let the view paint and attach handlers before we read frames.
  await flush();

  return {
    mockInput,
    captureCharFrame,
    teardown: async () => {
      renderer.destroy();
      await tuiPromise;
    },
  };
}

describe("TUI resume invariance", () => {
  testIfDocker("--resume <id> skips the starter menu entirely", async () => {
    const { captureCharFrame, teardown } = await bootStarterTui({ isResume: true });
    const frame = captureCharFrame().toLowerCase();
    expect(frame).not.toContain("what should we work on today");
    expect(frame).not.toContain("pick up the thread");
    expect(frame).not.toContain("or start something new");
    await teardown();
  });

  testIfDocker("bare boot renders the starter menu", async () => {
    const { captureCharFrame, teardown } = await bootStarterTui({ isResume: false });
    const frame = captureCharFrame().toLowerCase();
    // The test boots in a clean Docker home so `selectStarters` lands on
    // the "new user" branch every time. Anchor on the headline rather than
    // the trailing hint line — the hint wraps inside the transcript box
    // and the wrap point differs between macOS and Linux renderers, which
    // fragments `"or just start typing"` into separate visual rows on CI.
    expect(frame).toContain("what should we work on today");
    await teardown();
  });
});

describe("TUI starter chrome toggle", () => {
  testIfDocker("typing hides starters; backspacing the composer empty restores them", async () => {
    const { mockInput, captureCharFrame, teardown } = await bootStarterTui({ isResume: false });

    // Anchor on the headline (single-line, no wrap risk across platforms)
    // instead of the trailing hint, which wraps differently on Linux.
    const HEADLINE = "what should we work on today";

    // Boot has chrome visible.
    const boot = captureCharFrame().toLowerCase();
    expect(boot).toContain(HEADLINE);

    // Typing hides the chrome.
    await mockInput.typeText("h");
    await flush();
    const typed = captureCharFrame().toLowerCase();
    expect(typed).not.toContain(HEADLINE);

    // Backspace-to-empty restores it.
    mockInput.pressBackspace();
    await flush();
    const restored = captureCharFrame().toLowerCase();
    expect(restored).toContain(HEADLINE);

    await teardown();
  });

  testIfDocker(
    "chrome position is stable across repeated type → backspace cycles (no spacer leak)",
    async () => {
      const { mockInput, captureCharFrame, teardown } = await bootStarterTui({ isResume: false });

      // Anchor on the headline row (single-line, no wrap risk). If
      // `mountStarterChrome` leaks untracked spacer renderables, every
      // remount lands a few cells further down and this row drifts.
      function headlineRow(): number {
        const lines = captureCharFrame().toLowerCase().split("\n");
        return lines.findIndex((line) => line.includes("what should we work on today"));
      }

      const initial = headlineRow();
      expect(initial).toBeGreaterThan(0);

      // Cycle five times. If `mountStarterChrome` leaks untracked spacer
      // renderables, the hint row drifts a few cells lower each cycle.
      for (let i = 0; i < 5; i += 1) {
        await mockInput.typeText("x");
        await flush();
        mockInput.pressBackspace();
        await flush();
      }

      const after = headlineRow();
      expect(after).toBe(initial);

      await teardown();
    },
  );
});
