import { afterEach, beforeEach, describe, expect } from "bun:test";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * End-to-end TUI rendering smoke test.
 *
 * Boots the real `runTui` on top of `createTestRenderer` + the
 * `FakePlaygroundRunner`, drives a typed prompt through the production
 * input pipeline, waits for the runner's terminal event, and asserts the
 * agent's reply actually painted into the captured frame. This is the
 * contract that regressed in v0.1.63 (orphan TextRenderable created by
 * the upgrade-status subscriber broke subsequent transcript writes — the
 * turn ran, but no output ever appeared).
 *
 * Intentionally generic: anything that breaks the
 * `submit → session event → renderStep → transcript paint` chain trips
 * this test, regardless of which subsystem caused it.
 */
describe("TUI rendering smoke test", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("agent reply renders into the transcript frame", async () => {
    // `/echo` streams the trailing text back verbatim. A deterministic
    // single-word payload keeps the assertion immune to line wrapping at
    // the harness's 100-column default.
    await harness.mockInput.typeText("/echo hellofromrunner");
    harness.mockInput.pressEnter();

    await harness.waitForPrompt();
    await harness.waitForTerminal();
    // One extra tick so the final `complete` handler's frame paint settles
    // before we snapshot.
    await harness.flush();

    const frame = await harness.captureCharFrame();

    // The streamed agent reply must land in the rendered frame. The boot
    // banner / playground menu may push the user submit out of the visible
    // viewport (sticky-scroll pins to the bottom), so we only assert on the
    // reply itself — that is the contract that regressed in v0.1.63.
    expect(frame).toContain("hellofromrunner");
  });

  testIfDocker("idle hint footer advertises Enter: send", async () => {
    // The idle hint footer documents the Enter contract to the user. The
    // string lives in src/tui/theme.ts but the only behavior that matters
    // is that the production chrome actually paints it on boot.
    const frame = await harness.captureCharFrame();
    expect(frame).toContain("Enter: send");
  });

  testIfDocker("router switches render a notice and refresh the sidebar target", async () => {
    const status = {
      tier: "frontier",
      route: "implement",
      modelName: "gpt-5.6-sol",
      thinkingLevel: "high" as const,
      lastRationale: "The task entered its implementation phase.",
      assistantSteps: 5,
      stepsUntilClassification: 5,
      pinned: false,
      advisorEnabled: true,
      advisorGate: { allowed: true, stepsUntilAllowed: 0 },
      facts: { hasImages: false },
    };
    Object.assign(harness.runner, { routeStatus: () => status });

    harness.runner.emitEvent({
      type: "router_switch",
      tier: "frontier",
      route: "implement",
      fromModel: "gpt-5.6-luna",
      toModel: "gpt-5.6-sol",
      thinkingLevel: "high",
      trigger: "cadence",
      rationale: status.lastRationale,
      visionFallback: false,
      compactRecommended: true,
    });
    await harness.flush();

    const frame = await harness.captureCharFrame();
    // The notice wraps at the transcript pane width, so assert on fragments
    // that each fit within one rendered line rather than the whole string.
    expect(frame).toContain("[route] frontier: gpt-5.6-luna");
    expect(frame).toContain("via cadence check");
    expect(frame).toContain("frontier → gpt-5.6-sol (high)");
  });
});
