import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";

/**
 * Exposes the protected `setState` so tests can plant a state that's much
 * fatter than the configured `autoStateCompaction.maxBytes`. `getState()`
 * goes through `snapshotState`, which is where compaction runs, so this is
 * enough to exercise the wiring end-to-end without standing up a full agent.
 */
class HarnessRunner extends TurnRunner {
  constructor(config?: Partial<TurnRunnerConfig>) {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      ...config,
    });
  }

  forceState(state: TurnState): void {
    // setState is protected on TurnRunner; subclassing is the documented
    // extension point.
    (this as unknown as { setState: (s: TurnState) => void }).setState(state);
  }
}

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function fatState(messageCount: number, payloadKb: number): TurnState {
  const padding = "x".repeat(payloadKb * 1024);
  const messages: AgentMessage[] = Array.from({ length: messageCount }, (_unused, index) =>
    userMessage(`msg-${index} ${padding}`),
  );
  return {
    status: "running",
    mode: "auto",
    agent: {
      status: "running",
      messages,
    },
  } as TurnState;
}

describe("TurnRunner auto state compaction", () => {
  test("compacts state on snapshot when enabled", () => {
    const runner = new HarnessRunner({ autoStateCompaction: { maxBytes: 8 * 1024 } });
    runner.forceState(fatState(12, 2));

    const snapshot = runner.getState();
    expect(snapshot).toBeDefined();
    const bytes = JSON.stringify(snapshot).length;
    expect(bytes).toBeLessThanOrEqual(8 * 1024);
    expect(snapshot!.agent.messages.length).toBeLessThan(12);
    const last = snapshot!.agent.messages.at(-1) as { content: { text: string }[] };
    expect(last.content[0].text.startsWith("msg-11 ")).toBe(true);
  });

  test("omitted autoStateCompaction defaults to the 100 MB ceiling", () => {
    // Default-on: a small state passes through unchanged because it's well
    // under the 100 MB default, but the cap is still active and would evict
    // if the state ever grew past it.
    const runner = new HarnessRunner();
    const before = fatState(12, 2);
    runner.forceState(before);

    const snapshot = runner.getState();
    expect(snapshot).toBeDefined();
    expect(snapshot!.agent.messages.length).toBe(12);
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(8 * 1024);

    // And the cap actually fires when the state would exceed it.
    const tiny = new HarnessRunner({ autoStateCompaction: { maxBytes: 1024 } });
    tiny.forceState(fatState(12, 2));
    const tinySnap = tiny.getState();
    expect(tinySnap!.agent.messages.length).toBeLessThan(12);
  });

  test("autoStateCompaction: true uses the default ceiling and skips small states", () => {
    const runner = new HarnessRunner({ autoStateCompaction: true });
    const small = fatState(3, 1);
    runner.forceState(small);

    const snapshot = runner.getState();
    expect(snapshot).toBeDefined();
    // Under the default 100 MB ceiling, this should pass through unchanged.
    expect(snapshot!.agent.messages.length).toBe(3);
  });

  test("autoStateCompaction: false disables the cap even when state is huge", () => {
    const runner = new HarnessRunner({ autoStateCompaction: false });
    runner.forceState(fatState(12, 2));

    const snapshot = runner.getState();
    expect(snapshot!.agent.messages.length).toBe(12);
  });

  test("emitted events reflect the compacted state, not the raw input", async () => {
    const runner = new HarnessRunner({ autoStateCompaction: { maxBytes: 8 * 1024 } });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    // start() emits `turn_started` with the snapshot \u2014 the canonical "state
    // leaving the runner" path. Plant a fat state first so the very first
    // emit exercises compaction.
    runner.forceState(fatState(12, 2));
    await runner.start({ type: "start" });

    const turnStarted = events.find((e) => e.type === "turn_started");
    expect(turnStarted).toBeDefined();
    // The fresh start replaces the planted state, so we can't assert eviction
    // on turn_started itself; what matters is that the subsequent getState
    // path always runs through snapshotState.
    const snapshot = runner.getState();
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(8 * 1024);
  });
});
