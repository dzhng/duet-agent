import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { TurnEvent, TurnTerminalEvent } from "../../../src/types/protocol.js";
import {
  assertGradeableDeepSweOutcome,
  parseKnownEvents,
  summarizeDeepSweRun,
} from "../src/summary.js";

describe("DeepSWE wire accounting", () => {
  test("uses final cumulative totals and retains classifier/advisor model attribution", () => {
    const terminal = {
      type: "complete",
      status: "completed",
      turnUsage: usage(30, 3),
      usageByModel: [
        { model: "executor", usage: usage(10, 1) },
        { model: "classifier", usage: usage(10, 1) },
        { model: "advisor", usage: usage(10, 1) },
      ],
    } as unknown as TurnTerminalEvent;
    const summary = summarizeDeepSweRun({
      terminal,
      events: [
        {
          type: "usage",
          turnUsage: usage(10, 1),
          usageByModel: [{ model: "executor", usage: usage(10, 1) }],
        },
        terminal,
      ] as TurnEvent[],
      timedOut: false,
      wallClockMs: 123,
    });

    expect(summary.telemetry.costUsdTotal).toBe(3);
    expect(summary.telemetry.usageByModel.map((entry) => entry.model)).toEqual([
      "executor",
      "classifier",
      "advisor",
    ]);
    expect(summary.wallClockMs).toBe(123);
  });

  test("keeps future event variants in the parsed ledger and ignores malformed lines", () => {
    const events = parseKnownEvents([
      JSON.stringify({ type: "future_protocol_event", payload: { stable: true } }),
      "not-json",
    ]);
    expect(events).toEqual([{ type: "future_protocol_event", payload: { stable: true } }]);
  });

  test("classifies a pre-terminal process exit as infrastructure", () => {
    const processExit = {
      terminal: "killed",
      events: [],
      timedOut: false,
      killedReason: "process_exit",
      wallClockMs: 10,
    } as const;
    expect(() => assertGradeableDeepSweOutcome(processExit)).toThrow(
      "before emitting a terminal event",
    );
    expect(() =>
      assertGradeableDeepSweOutcome({
        ...processExit,
        timedOut: true,
        killedReason: "wall_clock",
      }),
    ).not.toThrow();
  });

  test("reads the repository RPC fixture without changing its cumulative cost", async () => {
    const lines = (
      await Bun.file(
        join(import.meta.dir, "../../swebench/fixtures/economy-rpc.sanitized.ndjson"),
      ).text()
    )
      .trim()
      .split("\n");
    const events = parseKnownEvents(lines);
    const terminal = events.at(-1) as TurnTerminalEvent;
    const summary = summarizeDeepSweRun({
      terminal,
      events,
      timedOut: false,
      wallClockMs: 10,
    });
    expect(summary.telemetry.costUsdTotal).toBe(0.006905);
    expect(summary.telemetry.usageByModel[0]?.model).toBe("openai/gpt-5.6-luna");
  });
});

function usage(input: number, cost: number) {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}
