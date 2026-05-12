import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { applyEvictionHorizon } from "../src/turn-runner/wire-shaping.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "haiku-4.5";

/**
 * Live test for the runner's provider-overflow recovery branch in
 * `runAgentWorker`. In production, wire-shaping evicts preemptively
 * whenever its byte-based estimate trips, so the provider rejection
 * path is reached only when the local estimate underestimates the
 * real provider tokenizer (heavy tool/thinking blocks, structured
 * payloads, etc.). To exercise the same code path deterministically
 * the eval swaps the memory transform for one that *only* applies the
 * sticky horizon — no preemptive trigger — so the first attempt
 * dispatches the full seeded history and the second attempt sees the
 * halved list the recovery branch produced.
 *
 * Everything else (the model, the gateway, the
 * `isContextOverflow` detection, `agent.continue()`, system event
 * emission) runs live so a regression in any of those layers would
 * surface here.
 */
class ProviderOverflowEvalRunner extends TurnRunner {
  getEvictionHorizon(): number {
    return this.wireGuardHorizon.evictionHorizon;
  }

  protected override createMemoryTransform() {
    return async (messages: AgentMessage[]) =>
      applyEvictionHorizon(messages, this.wireGuardHorizon.evictionHorizon);
  }
}

describe("provider context-overflow recovery", () => {
  testIfDocker(
    "halves history and retries after the provider rejects an oversized prompt",
    async () => {
      const runner = new ProviderOverflowEvalRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      // Seed the parent agent's transcript with enough prior turns to
      // blow past the model's hard context window on the first send.
      // Passing `state` to `start` is the protocol-level way to resume
      // from prior history, so the live agent transcript starts at the
      // size we constructed without a separate ingest step.
      await runner.start({
        type: "start",
        state: {
          status: "running",
          mode: "agent",
          agent: { status: "running", messages: buildOversizedHistory() },
        },
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));

      const terminal = await runner.turn({
        type: "prompt",
        message: "Reply with exactly one word: recovered.",
        behavior: "follow_up",
      });

      expect(terminal.type).toBe("complete");
      if (terminal.type !== "complete") throw new Error("expected complete terminal");
      expect(terminal.status).toBe("completed");
      expect(terminal.result?.toLowerCase()).toContain("recovered");

      // The recovery branch advanced the sticky horizon past at least
      // one observable message — that is what made the retry fit.
      expect(runner.getEvictionHorizon()).toBeGreaterThan(0);

      const recoveryNotices = events.filter(
        (event): event is Extract<TurnEvent, { type: "system" }> =>
          event.type === "system" && event.message.startsWith("Context overflow"),
      );
      expect(recoveryNotices).toHaveLength(1);
      expect(recoveryNotices[0]!.level).toBe("info");
      expect(recoveryNotices[0]!.message).toMatch(/dropped \d+ older message/);
    },
    180_000,
  );
});

/**
 * Build a synthetic prior-turn transcript whose total wire size reliably
 * pushes the first send past a 200k-token context window. Repeated
 * "lorem ipsum" is highly tokenizer-compressible, so we oversize the raw
 * bytes well beyond a naive chars/token estimate to ensure the provider
 * actually rejects the first attempt — that rejection is what triggers
 * the recovery branch under test. After the recovery branch advances
 * the sticky horizon past the older half, the remaining transcript fits.
 */
function buildOversizedHistory(): AgentMessage[] {
  // ~14 KB per message * 100 messages = ~1.4 MB total raw text. Sized so
  // the full transcript overflows haiku-4.5's window but the halved
  // transcript the recovery branch produces fits.
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(250);
  const messages: AgentMessage[] = [];
  for (let pair = 0; pair < 50; pair++) {
    const userTimestamp = pair * 2 + 1;
    const assistantTimestamp = pair * 2 + 2;
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Turn ${pair} user notes: ${filler}` }],
      timestamp: userTimestamp,
    });
    messages.push(
      createAssistantMessage({
        text: `Turn ${pair} assistant notes: ${filler}`,
        timestamp: assistantTimestamp,
      }),
    );
  }
  return messages;
}
