import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { usageFromMessages } from "../src/turn-runner/usage-accounting.js";
import type { TurnEvent, TurnTokenUsage, TurnUsageEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/** Assert two usage records are byte-identical token-wise and equal in total cost. */
function expectSameUsage(actual: TurnTokenUsage, expected: TurnTokenUsage, label: string) {
  expect(actual.input, `${label}: input`).toBe(expected.input);
  expect(actual.output, `${label}: output`).toBe(expected.output);
  expect(actual.cacheRead, `${label}: cacheRead`).toBe(expected.cacheRead);
  expect(actual.cacheWrite, `${label}: cacheWrite`).toBe(expected.cacheWrite);
  expect(actual.totalTokens, `${label}: totalTokens`).toBe(expected.totalTokens);
  expect(actual.cost.total, `${label}: cost.total`).toBeCloseTo(expected.cost.total, 9);
}

/**
 * Per-completion usage streaming changed *when* cost surfaces (a `usage` event
 * per completion instead of one aggregate at the worker boundary). The user's
 * guarantee is that it must not move the final numbers by a single token or
 * cent — on either the last `usage` event or the terminal payload.
 *
 * This eval drives a real model through a tool-heavy turn (several sequential
 * completions) and pins all three views of the final aggregate to each other:
 *   - the LAST streamed `usage` event's `turnUsage`,
 *   - the terminal event's `turnUsage`,
 *   - `usageFromMessages` over the final transcript — which is exactly the
 *     summation the pre-change code performed at the worker boundary.
 * Equality across all three is the "numbers are identical before and after"
 * proof, asserted against live provider-reported usage rather than a stub.
 *
 * Falsification (run this eval with the streaming change reverted): the
 * pre-change runner emitted a single `usage` event for the whole turn, so
 * `usageEvents.length >= 3` drops below the old ceiling of 1 and the eval goes
 * red — pinning it to the per-completion behavior. The equality assertions
 * additionally hold across the refactor, so they document the invariant the
 * change preserves.
 */
describe("usage aggregate invariance", () => {
  testIfDocker(
    "the final usage event and the terminal both equal usageFromMessages exactly",
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

      // Sequential commands the model cannot batch: each depends on seeing the
      // previous output, so each is its own completion -> its own message_end
      // -> its own usage event.
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
            Run these shell commands ONE AT A TIME, in order, waiting to see each
            command's output before running the next. Do not batch them into a
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

      // The turn really exercised the completion loop via tool calls.
      expect(
        bashCommands.length,
        `expected multiple bash calls; saw ${JSON.stringify(bashCommands)}`,
      ).toBeGreaterThanOrEqual(2);

      const usageEvents = events.filter((e): e is TurnUsageEvent => e.type === "usage");

      // Falsifier: per-completion streaming emits one usage event per
      // completion; the pre-change worker-boundary code emitted exactly one for
      // the whole turn. Three is a conservative floor above that old ceiling.
      expect(
        usageEvents.length,
        `expected a usage event per completion; saw ${usageEvents.length}`,
      ).toBeGreaterThanOrEqual(3);

      expect(terminal.turnUsage).toBeDefined();
      const terminalUsage = terminal.turnUsage!;

      // Canonical aggregate: the exact summation the pre-change code computed.
      const fromMessages = usageFromMessages(terminal.state.agent.messages);
      expect(fromMessages).toBeDefined();

      // The numbers that survive the refactor: last streamed event == terminal
      // == sum over the transcript. None of these may drift by a token or cent.
      const lastUsage = usageEvents.at(-1)!;
      expectSameUsage(lastUsage.turnUsage, terminalUsage, "last usage event vs terminal");
      expectSameUsage(terminalUsage, fromMessages!, "terminal vs usageFromMessages");

      // Streamed aggregate is monotonic non-decreasing across completions.
      for (let i = 1; i < usageEvents.length; i++) {
        expect(usageEvents[i]!.turnUsage.totalTokens).toBeGreaterThanOrEqual(
          usageEvents[i - 1]!.turnUsage.totalTokens,
        );
        expect(usageEvents[i]!.turnUsage.cost.total).toBeGreaterThanOrEqual(
          usageEvents[i - 1]!.turnUsage.cost.total,
        );
      }

      // Per-model breakdown reconciles with the scalar total.
      const modelCostTotal = (terminal.usageByModel ?? []).reduce(
        (sum, entry) => sum + entry.usage.cost.total,
        0,
      );
      expect(modelCostTotal).toBeCloseTo(terminalUsage.cost.total, 9);
    },
    180_000,
  );
});
