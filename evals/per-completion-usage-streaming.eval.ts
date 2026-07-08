import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnUsageEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * A turn is a loop of completion calls: assistant message -> tool calls ->
 * tool results -> next completion, until the model stops calling tools. Each
 * completion's `message_end` carries its own provider-reported usage, so a
 * tool-heavy turn must stream a `usage` event per completion rather than a
 * single aggregate at the end of the turn. This is a plain agent turn with no
 * state machine — the granularity comes from the completion loop itself.
 *
 * Falsification: before per-completion streaming, the runner only recorded
 * usage once at the worker boundary (summing every assistant message), so the
 * whole turn emitted exactly ONE `usage` event regardless of tool-call count.
 * `usageEvents.length >= 3` is below the old ceiling of 1 and fails red.
 */
describe("per-completion usage streaming", () => {
  testIfDocker(
    "a tool-heavy single turn emits a usage event per completion, monotonic and matching the terminal",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      const events: TurnEvent[] = [];
      const bashCommands: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        events.push(event);
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type === "tool_call_start" && step.toolName === "bash") {
          const input = step.input as { command?: string } | undefined;
          bashCommands.push(input?.command ?? "");
        }
      });

      // Force several sequential completion rounds: each command depends on
      // seeing the previous result, so the model cannot batch them into one
      // assistant message. Each round is its own completion -> its own
      // message_end -> its own usage event.
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
            Run these shell commands ONE AT A TIME, in order, waiting to see each
            command's output before running the next one. Do not batch them into a
            single message. After each command, tell me what it printed.

            1. echo step-one
            2. echo step-two
            3. echo step-three

            When all three have run, give me a one-line summary.
          `,
        })
      ).turn;

      expect(terminal.type).toBe("complete");
      if (terminal.type !== "complete") throw new Error("expected complete");

      // The turn actually exercised tool calls (otherwise the multi-usage
      // claim would not be causally tied to the completion loop).
      expect(
        bashCommands.length,
        `expected multiple bash calls; saw ${JSON.stringify(bashCommands)}`,
      ).toBeGreaterThanOrEqual(2);

      const usageEvents = events.filter((e): e is TurnUsageEvent => e.type === "usage");
      // Sequential rounds plus the final summary completion give several
      // message_end events; the old single-emit code could only ever produce
      // one. Three is a conservative lower bound that still falsifies the old
      // behavior.
      expect(
        usageEvents.length,
        `expected a usage event per completion; saw ${usageEvents.length}`,
      ).toBeGreaterThanOrEqual(3);

      // The aggregate only grows: cost and tokens are non-decreasing across the
      // streamed events.
      for (let i = 1; i < usageEvents.length; i++) {
        expect(usageEvents[i]!.turnUsage.cost.total).toBeGreaterThanOrEqual(
          usageEvents[i - 1]!.turnUsage.cost.total,
        );
        expect(usageEvents[i]!.turnUsage.totalTokens).toBeGreaterThanOrEqual(
          usageEvents[i - 1]!.turnUsage.totalTokens,
        );
      }

      // Each event's single-completion snapshot is positive and bounded above
      // by the running aggregate it was folded into.
      for (const u of usageEvents) {
        expect(u.lastMessageUsage.totalTokens).toBeGreaterThan(0);
        expect(u.lastMessageUsage.totalTokens).toBeLessThanOrEqual(u.turnUsage.totalTokens);
      }

      // The terminal aggregate equals the last streamed usage event: streaming
      // per completion did not change the turn total, only when it surfaced.
      const lastUsage = usageEvents.at(-1)!;
      expect(terminal.turnUsage).toBeDefined();
      expect(terminal.turnUsage!.totalTokens).toBe(lastUsage.turnUsage.totalTokens);
      expect(terminal.turnUsage!.cost.total).toBeCloseTo(lastUsage.turnUsage.cost.total, 6);
    },
    180_000,
  );
});
