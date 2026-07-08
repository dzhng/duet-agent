import { afterEach, beforeEach, describe, expect } from "bun:test";

import { INITIAL_STATE } from "../examples/tui-playground.js";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * StepRenderer + session-subscription routing. Each test pushes a curated
 * event sequence through the runner's public `emitEvent` hook (the same
 * fan-out the scenario engine uses) and asserts on the resulting frame.
 *
 * These tests intentionally bypass the scenario layer so they can pin
 * narrow step contracts without paying scenario latency or relying on
 * scripted timing.
 */
describe("TUI streaming surface", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("text_delta + text renders the assistant body into the transcript", async () => {
    harness.runner.emitEvent({ type: "step", step: { type: "text_delta", delta: "stream" } });
    harness.runner.emitEvent({ type: "step", step: { type: "text_delta", delta: "ing-token" } });
    harness.runner.emitEvent({
      type: "step",
      step: { type: "text", text: "streaming-token-final" },
    });
    await harness.flush();

    const frame = await harness.captureCharFrame();
    expect(frame).toContain("streaming-token-final");
  });

  testIfDocker("reasoning_delta surfaces the [reasoning] label", async () => {
    harness.runner.emitEvent({
      type: "step",
      step: { type: "reasoning_delta", delta: "thinking about prerequisites" },
    });
    await harness.flush();
    await harness.flush();

    const frame = await harness.captureCharFrame();
    expect(frame).toContain("[reasoning]");
    expect(frame).toContain("thinking about prerequisites");
  });

  testIfDocker("tool_call then tool_result transitions from spinner to check glyph", async () => {
    harness.runner.emitEvent({
      type: "step",
      step: {
        type: "tool_call_start",
        toolName: "bash",
        toolCallId: "bash-1",
        input: { command: "echo hi" },
      },
    });
    await harness.flush();
    const runningFrame = await harness.captureCharFrame();
    // The running marker is the hourglass glyph appended to the header.
    expect(runningFrame).toContain("\u23F3");

    harness.runner.emitEvent({
      type: "step",
      step: {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "bash-1",
        input: { command: "echo hi" },
        isError: false,
        output: [{ type: "text", text: "hi" }],
      },
    });
    await harness.flush();
    const completedFrame = await harness.captureCharFrame();
    // Completion replaces the hourglass with a check glyph in the same
    // header row. The hourglass should be gone for this tool call.
    expect(completedFrame).toContain("\u2713");
    expect(completedFrame).not.toContain("\u23F3");
  });

  testIfDocker(
    "memory event with phase: observation updates the working status surface",
    async () => {
      // The working-status renderer only paints while a turn is in flight.
      // Drive a long-running scenario so `statusController.markRunning()`
      // fires before we push the memory event.
      await harness.mockInput.typeText("/working 30");
      await harness.flush();
      harness.mockInput.pressEnter();
      await harness.waitForPrompt();

      harness.runner.emitEvent({
        type: "memory",
        phase: "observation",
        status: "running",
        message: "Observing conversation into memory\u2026",
      });
      await harness.flush();
      await harness.flush();

      const frame = await harness.captureCharFrame();
      // The status line is "\u25CF <message> (Ns)" \u2014 anchor on the
      // observation phrase which is unique to this branch of `renderMemoryStatus`.
      expect(frame).toContain("Observing conversation into memory");
    },
  );

  testIfDocker("terminal usage produces a [usage] line with the reported tokens", async () => {
    harness.runner.emitEvent({
      type: "complete",
      status: "completed",
      result: "ok",
      state: { ...INITIAL_STATE, status: "completed" },
      turnUsage: {
        input: 12345,
        output: 678,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 13023,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    // Session.handleTurnEvent awaits a state-file write before fanning the
    // terminal event out to the TUI subscriber, so the [usage] paint is
    // strictly post-await. Wait on the terminal observer to confirm the
    // event has flowed Runner → Session → TUI before snapshotting.
    await harness.waitForTerminal();
    await harness.flush();

    const frame = await harness.captureCharFrame();
    expect(frame).toContain("[usage]");
    // The usage line renders the raw token counts verbatim so the test
    // catches off-by-one or unit confusion regressions.
    expect(frame).toContain("in=12345");
    expect(frame).toContain("out=678");
  });
});
