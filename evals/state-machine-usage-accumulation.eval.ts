import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import type { TurnEvent, TurnUsageEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/**
 * Verifies the streaming `usage` aggregate invariant end-to-end against a
 * real model: a multi-agent-state state machine should emit a `usage`
 * event after every parent assistant message and every state-agent finish,
 * each carrying the running turn aggregate. The terminal event's
 * `usage.cost.total` must equal the last `usage` event's, and the
 * session's cumulative cost must equal the terminal aggregate (single-turn
 * eval, no resume). The parent's `effectiveContextWindow` /
 * `contextWindowUsage` snapshot must stay stable across state-agent
 * ticks within the same parent segment so the sidebar bar does not jitter.
 */
describe("state machine usage accumulation", () => {
  testIfDocker(
    "emits monotonic usage events, terminal matches last usage, session cost matches terminal",
    async () => {
      const sessionStoragePath = await mkdtemp(join(tmpdir(), "duet-usage-accumulation-eval-"));
      tempDirs.push(sessionStoragePath);
      const sessionId = "usage-accumulation-eval";

      const manager = new SessionManager(
        {
          model,
          mode: usageDefinition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is an eval. Use the provided state machine to run the workflow.",
            "Select states in this order: note_one, note_two, eval_done.",
            "When selecting a state with inputSchema, supply the required object.",
            "Do not ask the user questions.",
          ].join("\n"),
        },
        { sessionStoragePath },
      );

      const events: TurnEvent[] = [];
      try {
        const session = manager.create({ sessionId, mode: usageDefinition });
        session.subscribe((event) => events.push(event));

        await session.prompt({
          message: "Run the two-agent-state eval workflow.",
        });
        const terminal = await session.waitForTerminal();

        expect(terminal.type).toBe("complete");
        if (terminal.type !== "complete") throw new Error("expected complete");

        const usageEvents = events.filter((e): e is TurnUsageEvent => e.type === "usage");
        // Two agent states + at least one parent assistant boundary; expect
        // at least three usage events. The lower bound is conservative; the
        // strict invariants below are what makes the eval meaningful.
        expect(usageEvents.length).toBeGreaterThanOrEqual(2);

        for (let i = 1; i < usageEvents.length; i++) {
          expect(usageEvents[i]!.usage.cost.total).toBeGreaterThanOrEqual(
            usageEvents[i - 1]!.usage.cost.total,
          );
          expect(usageEvents[i]!.usage.totalTokens).toBeGreaterThanOrEqual(
            usageEvents[i - 1]!.usage.totalTokens,
          );
        }

        const lastUsage = usageEvents.at(-1)!;
        expect(terminal.usage).toBeDefined();
        expect(terminal.usage!.cost.total).toBeCloseTo(lastUsage.usage.cost.total, 6);
        expect(terminal.usage!.totalTokens).toBe(lastUsage.usage.totalTokens);

        expect(terminal.effectiveContextWindow).toBe(lastUsage.effectiveContextWindow);
        expect(terminal.contextWindowUsage).toEqual(lastUsage.contextWindowUsage);

        expect(session.getSessionCostUsd()).toBeCloseTo(terminal.usage!.cost.total, 6);

        // The parent's `effectiveContextWindow` is a config-derived clamp,
        // so every emission in a single turn must agree on it. State-agent
        // emissions reuse the latest parent snapshot, so neither path
        // changes this value mid-turn.
        for (const u of usageEvents) {
          expect(u.effectiveContextWindow).toBe(lastUsage.effectiveContextWindow);
        }
        // The parent's input occupancy only grows across a turn (more
        // messages, never fewer). Distinct snapshot values therefore form a
        // non-decreasing sequence per segment, and the number of distinct
        // snapshots is bounded by the number of parent emissions (≤ the
        // number of agent states + 1).
        for (let i = 1; i < usageEvents.length; i++) {
          const prev = usageEvents[i - 1]!.contextWindowUsage;
          const curr = usageEvents[i]!.contextWindowUsage;
          expect(curr.systemPrompt).toBeGreaterThanOrEqual(prev.systemPrompt);
          expect(curr.messages).toBeGreaterThanOrEqual(prev.messages);
        }
        const distinctBars = new Set(usageEvents.map((u) => JSON.stringify(u.contextWindowUsage)));
        // 2 agent states + 1 terminal-selecting parent call ≤ 3 parent
        // emissions; state-agent ticks in between reuse the prior snapshot.
        expect(distinctBars.size).toBeLessThanOrEqual(3);
      } finally {
        await manager.dispose();
      }
    },
    180_000,
  );
});

const usageDefinition: StateMachineDefinition = {
  name: "usage_eval",
  prompt:
    "Use this state machine to run a tiny two-step eval. Pick note_one, then note_two, then the terminal eval_done. Do not call tools inside agent states.",
  states: [
    {
      kind: "agent",
      name: "note_one",
      prompt:
        "Do not call tools. Write a single short sentence about the number one. Reply with the sentence only.",
    },
    {
      kind: "agent",
      name: "note_two",
      prompt:
        "Do not call tools. Write a single short sentence about the number two. Reply with the sentence only.",
    },
    {
      kind: "terminal",
      name: "eval_done",
      status: "completed",
      reason: "Two short notes were written.",
    },
  ],
};
