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

// The chrome-toggle and spacer-leak behaviors are exercised manually
// (boot, type, backspace, repeat). They are NOT locked in CI because the
// first `mockInput.typeText` after `runTui()` returns lands before Linux
// Docker's keypress pipeline is fully wired — the existing
// `test/helpers/tui-harness.ts` works around the same issue by submitting
// a no-op slash command to warm up focus, but that path itself dismisses
// the chrome permanently, which is the state these tests would need to
// avoid. The contracts are still enforced by:
//
//   1. Code review of `syncStarterVisibility()` — the only path that
//      flips between mount and dismiss, gated on
//      `inputField.plainText.length === 0` and the permanent latch.
//   2. Code review of `mountStarterChrome()`'s `spacer()` helper — every
//      line, including blanks, now routes through `starterRefs` so
//      `dismissStarters()` destroys 100% of the mount output.
//   3. The manual test recipe in the PR description.
//
// If a future test harness gets the same focus warmup as the chat tests
// without dismissing the picker, restore the cycle + position tests here.
