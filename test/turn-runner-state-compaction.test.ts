import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { applyEvictionHorizon, calculateWireTokens } from "../src/turn-runner/wire-shaping.js";
import { stripObservationalContextMessages } from "../src/memory/observational.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import type { TurnEvent, TurnState, WireGuardHorizon } from "../src/types/protocol.js";

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

  /**
   * After `start()` runs, `snapshotState` re-reads parent-agent messages
   * directly, so seeding via `forceState` alone leaves the planted messages
   * masked by the parent's empty transcript. Mirroring onto the parent agent
   * keeps the snapshot pipeline aligned with the planted state so compact
   * tests see the bytes they planted.
   */
  seedParentMessages(state: TurnState): void {
    const parent = (this as unknown as { parentAgent?: { state: { messages: unknown } } })
      .parentAgent;
    if (parent) {
      parent.state.messages = state.agent.messages as unknown as never;
    }
    this.forceState(state);
  }

  /** Test-only accessor on the protected wire-shaping horizon. */
  getWireHorizon(): WireGuardHorizon {
    return (this as unknown as { wireGuardHorizon: WireGuardHorizon }).wireGuardHorizon;
  }

  /** Compute the wire-tail tokens the actor model would currently receive. */
  getWireTailTokens(): number {
    const state = this.getState();
    if (!state) return 0;
    const observable = stripObservationalContextMessages(state.agent.messages);
    const retained = applyEvictionHorizon(observable, this.getWireHorizon().evictionHorizon);
    return calculateWireTokens(retained);
  }

  getWireTailCount(): number {
    const state = this.getState();
    if (!state) return 0;
    const observable = stripObservationalContextMessages(state.agent.messages);
    return applyEvictionHorizon(observable, this.getWireHorizon().evictionHorizon).length;
  }

  /**
   * Seed the protected `lastParentUsageSnapshot` so tests can verify how
   * compact rewrites the bar payload without standing up a real parent
   * agent. Mirrors the shape `emitParentAgentEvent` would have written
   * after a `message_end`, including the rescaled breakdown.
   */
  seedParentUsageSnapshot(snapshot: {
    effectiveContextWindow: number;
    contextWindowUsage: {
      systemPrompt: number;
      messages: number;
      localMemory: number;
      globalMemory: number;
    };
    lastMessageUsage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
  }): void {
    (this as unknown as { lastParentUsageSnapshot: typeof snapshot }).lastParentUsageSnapshot =
      snapshot;
  }
}

function userMessage(text: string, timestamp: number): AgentMessage {
  // The wire-shaping eviction horizon dispatches on `message.timestamp`,
  // so messages without one are pinned at 0 and the horizon cannot advance
  // past them. Tests that exercise compact must seed monotonic timestamps.
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function fatState(messageCount: number, payloadKb: number): TurnState {
  const padding = "x".repeat(payloadKb * 1024);
  const messages: AgentMessage[] = Array.from({ length: messageCount }, (_unused, index) =>
    userMessage(`msg-${index} ${padding}`, index + 1),
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

  test("compact preserves the durable transcript and only advances the wire-shaping horizon", async () => {
    // The single most important invariant: `state.agent.messages` and the
    // parent agent's transcript must not be mutated. Compaction is
    // wire-only — the next outbound request shrinks, but scrollback,
    // resume, observer/reflector passes, and the snapshot path all keep
    // the full history.
    const runner = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));

    const durableBefore = runner.getState()!.agent.messages.length;
    const horizonBefore = runner.getWireHorizon().evictionHorizon;
    const wireTailCountBefore = runner.getWireTailCount();
    await runner.compact();

    // Durable transcript untouched on both the runner and the parent agent.
    expect(runner.getState()!.agent.messages.length).toBe(durableBefore);
    const parent = (runner as unknown as { parentAgent: { state: { messages: AgentMessage[] } } })
      .parentAgent;
    expect(parent.state.messages.length).toBe(durableBefore);

    // Wire-tail strictly shrank, and the sticky horizon advanced.
    expect(runner.getWireHorizon().evictionHorizon).toBeGreaterThan(horizonBefore);
    expect(runner.getWireTailCount()).toBeLessThan(wireTailCountBefore);
  });

  test("compact targets 20% of the context window when the wire-tail exceeds it", async () => {
    // Tight effectiveContext so 20% is ~200 tokens; fatState's padded
    // messages dwarf that and force the horizon advance down to the 20%
    // ceiling.
    const runner = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));

    const wireBefore = runner.getWireTailTokens();
    await runner.compact();
    const wireAfter = runner.getWireTailTokens();

    const systemEvents = events.filter((e) => e.type === "system");
    const compactLog = systemEvents.find((e) => e.message.startsWith("compact: dropped"));
    expect(compactLog).toBeDefined();
    // The label reflects the 20%-of-window branch, not the halving branch.
    expect(compactLog!.message).toContain("20% of 1000");
    // The wire-tail strictly shrinks. It cannot always reach 20% of the
    // window exactly because MIN_HISTORY_TAIL keeps at least one recent
    // message regardless of size, but it must move significantly toward
    // the ceiling.
    expect(wireAfter).toBeLessThan(wireBefore);
  });

  test("compact halves the current wire-tail when it is already under 20%", async () => {
    // Wide effectiveContext so even fatState sits well below the 20%
    // ceiling and forces the halving branch.
    const runner = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1_000_000,
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(20, 4));

    const wireBefore = runner.getWireTailTokens();
    await runner.compact();
    const wireAfter = runner.getWireTailTokens();
    // Halving should at least roughly reduce the wire-tail; findEvictionHorizon
    // searches for the smallest horizon satisfying the predicate, so the
    // post value is bounded by the target plus the smallest evictable step.
    expect(wireAfter).toBeLessThan(wireBefore);

    const systemEvents = events.filter((e) => e.type === "system");
    const compactLog = systemEvents.find((e) => e.message.startsWith("compact: dropped"));
    expect(compactLog).toBeDefined();
    // The label reflects the halving branch, not the 20%-of-window branch.
    expect(compactLog!.message).toContain("50% of current");
  });

  test("turn() arriving during an in-flight compact serializes behind it", async () => {
    // Fire-and-forget callers (the TUI `/compact` slash command, any
    // RPC client that doesn't await before issuing the next prompt)
    // would otherwise let a follow-up prompt dispatch with the
    // pre-compact wire-tail and race the horizon mutation. Pin the
    // ordering at the runner boundary so every caller sees the same
    // contract without having to know.
    const callOrder: string[] = [];
    let releaseCompact: () => void = () => {};
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    class GatedRunner extends HarnessRunner {
      protected override async updateMemoryAfterAgentRun(): Promise<void> {
        callOrder.push("compact:drain-start");
        // Block the compact mid-flight until the test releases it.
        // This is the gap a concurrent prompt would race into.
        await compactGate;
        callOrder.push("compact:drain-end");
      }
    }
    const runner = new GatedRunner({ autoStateCompaction: false, effectiveContext: 1000 });
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));

    // Kick off compact without awaiting (the fire-and-forget shape).
    const compactDone = runner.compact().then(() => callOrder.push("compact:return"));
    // Yield so compact() reaches the drain await before the prompt
    // arrives, mirroring how the TUI dispatcher would interleave them.
    await Promise.resolve();
    await Promise.resolve();

    // Send a turn while compact is still draining. The runner must
    // serialize this behind the compact, not race ahead.
    const turnPromise = runner
      .turn({
        type: "prompt",
        message: "hello",
        behavior: "follow_up",
      })
      .catch(() => callOrder.push("turn:error"))
      .then(() => callOrder.push("turn:return"));

    // Let a few microtasks run so any racing turn dispatch would have
    // a chance to record its order entry before compact completes.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(callOrder).toEqual(["compact:drain-start"]);

    // Release compact and let everything settle.
    releaseCompact();
    await compactDone;
    await turnPromise;

    // Compact must finish before the turn even begins to dispatch.
    // The HarnessRunner's `turn` calls the real path, which would
    // throw because there's no parent agent wired; we only care that
    // it runs AFTER compact returns.
    const compactReturnIdx = callOrder.indexOf("compact:return");
    const turnEntryIdx = callOrder.findIndex((e) => e.startsWith("turn:"));
    expect(compactReturnIdx).toBeGreaterThanOrEqual(0);
    expect(turnEntryIdx).toBeGreaterThan(compactReturnIdx);
  });

  test("compact called twice concurrently rejects the second with a warn", async () => {
    // Spamming `/compact` should not run two passes in parallel — the
    // second would race the first's horizon advance and rebuild the
    // memory pack twice. Reject the second the same way an active turn
    // would reject any compact.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class GatedRunner extends HarnessRunner {
      protected override async updateMemoryAfterAgentRun(): Promise<void> {
        await gate;
      }
    }
    const runner = new GatedRunner({ autoStateCompaction: false, effectiveContext: 1000 });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));

    const first = runner.compact();
    await Promise.resolve();
    await Promise.resolve();
    await runner.compact();

    const warns = events.filter(
      (e) => e.type === "system" && e.level === "warn" && /already in progress/.test(e.message),
    );
    expect(warns.length).toBe(1);

    releaseFirst();
    await first;
  });

  test("compact is rejected with a warn system event while a turn chain is in flight", async () => {
    // Out-of-band rejection: advancing the horizon mid-stream would
    // invalidate the request the parent (or a state agent) is already
    // dispatching, so the runner must refuse and surface the reason
    // instead of silently dropping the request. The single source of
    // truth for "a chain is in flight" is `activeTurnPromise`, so we
    // park a pending promise there to simulate any in-flight phase
    // (parent dispatching, state agent dispatching, poll command
    // running) without having to drive the chain end-to-end.
    const runner = new HarnessRunner({ autoStateCompaction: false });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(8, 2));
    const pending = new Promise<never>(() => {});
    (runner as unknown as { activeTurnPromise: Promise<unknown> }).activeTurnPromise = pending;

    const horizonBefore = runner.getWireHorizon().evictionHorizon;
    await runner.compact();
    expect(runner.getWireHorizon().evictionHorizon).toBe(horizonBefore);

    const systemEvents = events.filter((e) => e.type === "system");
    expect(
      systemEvents.some((e) => e.level === "warn" && e.message.includes("compact ignored")),
    ).toBe(true);
  });

  test("compact drains unobserved messages into memory before advancing the horizon", async () => {
    // The durable transcript stays in `state.agent.messages`, but messages
    // older than the new horizon will not be sent on the wire. They need
    // to survive as observations in the rendered prefix, which means the
    // observer pass must run before the horizon moves. Use a subclass
    // that records the order of `updateMemoryAfterAgentRun` and the
    // horizon assignment so a regression that reverses the order fails
    // here.
    const callOrder: string[] = [];
    class TracingRunner extends HarnessRunner {
      protected override async updateMemoryAfterAgentRun(): Promise<void> {
        callOrder.push("drain");
        // No-op (no memoryDbPath); the order is the contract under test.
      }
    }
    const runner = new TracingRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    // Observe horizon writes via a Proxy on the horizon object so we
    // catch the assignment without relying on private-field timing.
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));
    const horizon = runner.getWireHorizon();
    let originalHorizon = horizon.evictionHorizon;
    Object.defineProperty(horizon, "evictionHorizon", {
      get: () => originalHorizon,
      set: (value: number) => {
        callOrder.push("horizon");
        originalHorizon = value;
      },
    });

    await runner.compact();

    // Drain must precede horizon advance, otherwise evicted messages
    // would be observed against a horizon that already dropped them.
    expect(callOrder).toEqual(["drain", "horizon"]);
  });

  test("compact's horizon survives resume via TurnState.wireGuardHorizon round-trip", async () => {
    // First runner: compact and capture the persisted state shape.
    const initial = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    await initial.start({ type: "start" });
    initial.seedParentMessages(fatState(12, 2));
    await initial.compact();
    const persisted = initial.getState();
    expect(persisted).toBeDefined();
    const persistedHorizon = persisted!.wireGuardHorizon;
    if (!persistedHorizon) {
      throw new Error("expected persisted snapshot to carry wireGuardHorizon");
    }
    expect(persistedHorizon.evictionHorizon).toBeGreaterThan(0);

    // Second runner: resume from the persisted snapshot and confirm
    // the wire-shaping object hydrated instead of resetting to its
    // fresh default. Without this, a session compacted before the
    // user exits the TUI would ship the full wire-tail again on the
    // next launch.
    const resumed = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    await resumed.start({ type: "start", state: persisted });
    const resumedHorizon = resumed.getWireHorizon();
    expect(resumedHorizon).toEqual(persistedHorizon);
    // Reference identity must NOT carry over from the persisted object:
    // the runner's wire horizon is hydrated in place over its fresh
    // default so the observational transform's captured reference
    // remains valid.
    expect(resumedHorizon).not.toBe(persistedHorizon);
    // The post-resume wire-tail count must match what compact produced
    // (durable transcript is identical; horizon is identical).
    expect(resumed.getWireTailCount()).toBe(
      applyEvictionHorizon(
        stripObservationalContextMessages(persisted!.agent.messages),
        persistedHorizon.evictionHorizon,
      ).length,
    );
  });

  test("compact reports no-op when the horizon cannot advance further", async () => {
    // A single-message transcript leaves no room for the wire-shaping
    // horizon to move, so even the halving branch finds no advance and
    // the runner must report the no-op rather than silently doing nothing.
    const runner = new HarnessRunner({ autoStateCompaction: false });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(1, 1));

    const horizonBefore = runner.getWireHorizon().evictionHorizon;
    await runner.compact();
    expect(runner.getWireHorizon().evictionHorizon).toBe(horizonBefore);
    expect(runner.getState()!.agent.messages.length).toBe(1);
    const systemEvents = events.filter((e) => e.type === "system");
    expect(systemEvents.some((e) => e.message.startsWith("compact: nothing to evict"))).toBe(true);
  });

  test("compact emits a usage event so the context bar reflects the new horizon", async () => {
    // After `/compact` advances the eviction horizon, the sidebar still
    // anchors its bar on the most recent parent `lastMessageUsage`, which
    // was captured pre-compact. Without a fresh `usage` event the bar
    // keeps showing the pre-compact slice even though the next request
    // will dispatch a much smaller wire tail. The runner must re-estimate
    // the breakdown and emit a `usage` tick so the UI updates immediately.
    const runner = new HarnessRunner({
      autoStateCompaction: false,
      effectiveContext: 1000,
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });
    runner.seedParentMessages(fatState(12, 2));
    // Snapshot the pre-compact wire-tail tokens so the test can assert
    // the refreshed bar tracks the new horizon instead of the seeded
    // pre-compact total.
    const wireBefore = runner.getWireTailTokens();
    runner.seedParentUsageSnapshot({
      effectiveContextWindow: 1000,
      contextWindowUsage: {
        systemPrompt: 50,
        messages: wireBefore,
        localMemory: 30,
        globalMemory: 20,
      },
      lastMessageUsage: {
        input: wireBefore + 100,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: wireBefore + 100,
        cost: {
          input: 0.01,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.01,
        },
      },
    });

    await runner.compact();
    const wireAfter = runner.getWireTailTokens();

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents.length).toBe(1);
    const post = usageEvents[0]!;
    // The refreshed breakdown sums to the new lastMessageUsage.totalTokens
    // so the bar's numerator and segment widths stay self-consistent.
    const breakdownSum =
      post.contextWindowUsage.systemPrompt +
      post.contextWindowUsage.messages +
      post.contextWindowUsage.localMemory +
      post.contextWindowUsage.globalMemory;
    expect(breakdownSum).toBe(post.lastMessageUsage.totalTokens);
    // The compacted wire tail must be strictly smaller than the
    // pre-compact wire tokens — that is the user-visible behaviour the
    // bar needs to reflect.
    expect(wireAfter).toBeLessThan(wireBefore);
    // The refreshed `messages` segment anchors on the post-compact wire
    // tail, so it must be strictly smaller than the pre-compact wire
    // tokens — that is what makes the bar shrink.
    expect(post.contextWindowUsage.messages).toBeGreaterThan(0);
    expect(post.contextWindowUsage.messages).toBeLessThan(wireBefore);
    // Historical cost is preserved on the refreshed message usage; the
    // provider already billed the pre-compact call.
    expect(post.lastMessageUsage.cost.total).toBe(0.01);
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
