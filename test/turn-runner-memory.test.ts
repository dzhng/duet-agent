import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  agentMessageToRaw,
  agentMessagesToRaw,
  CHARS_PER_TOKEN,
  compactObservationalContext,
  enforceObservationTokenBudget,
  getUnobservedMessageTail,
  trimMessagesToTranscriptBudget,
  stripObservationalContextMessages,
} from "../src/memory/observational.js";
import { MemoryContextCache } from "../src/memory/store.js";
import { createInitialHorizon } from "../src/turn-runner/wire-shaping.js";
import { buildObserverPrompt } from "../src/memory/observational-prompts.js";
import {
  scaleContextWindowUsageToTotalTokens,
  TurnRunner,
  type AgentConfigInput,
} from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnEvent, TurnOptions } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { withheldAskReminder, parkNudge } from "../src/turn-runner/prompts.js";
import { settlementNotice } from "../src/turn-runner/task-tools.js";
import { updateEntry, writeEntry } from "../src/memory/store/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

class MemoryTransformTurnRunner extends TurnRunner {
  createMemoryTransformForTest() {
    return this.createMemoryTransform();
  }

  /**
   * Test-only synthetic seeding: the runner has no PGlite database
   * configured here, so we mint an Observation in process and shove
   * it into the cache as if a compaction had just frozen it. That
   * matches the production invariant (only the cache shape matters
   * to the transform) without spinning up a real database.
   */
  async seedFrozenObservationForTest(content: string) {
    const now = Date.now();
    const observation = {
      id: `mem_test_${now}`,
      createdAt: now,
      lastUsedAt: now,
      kind: "observation" as const,
      observedDate: "2026-05-06",
      priority: "high" as const,
      source: { kind: "system" } as const,
      content,
      tags: ["test"],
    };
    this.memory.setContextPack({ global: [observation], local: [] });
    return observation;
  }

  getFrozenContextPackForTest() {
    return this.memory.getContextPack();
  }
}

describe("synthetic user-message filtering", () => {
  test("drops pure runtime injections and preserves adjacent real user text", () => {
    const settlement = settlementNotice([
      {
        descriptor: {
          id: "t1",
          kind: "tool",
          name: "bash",
          label: "fixture",
          ownerScopeId: "turn-1",
          status: "completed",
          startedAt: 1,
        },
        output: ["done"],
        settlement: { id: "t1", status: "completed", settledAt: 2, result: "done" },
      },
    ]);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: withheldAskReminder([{ question: "Deploy now?", options: [] }]),
        timestamp: 1,
      },
      { role: "user", content: settlement, timestamp: 2 },
      { role: "user", content: `Keep the real request.\n\n${parkNudge("approval")}`, timestamp: 3 },
      createAssistantMessage({ text: "Acknowledged.", timestamp: 4 }),
    ];

    expect(
      agentMessagesToRaw(stripObservationalContextMessages(messages)).map(({ role, content }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "Keep the real request." }] },
      { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] },
    ]);
  });
});

class ModelRoutingTurnRunner extends TurnRunner {
  private capturedAgentModel?: Model<any>;
  private capturedMemoryModel?: string;

  async captureModels(options?: TurnOptions): Promise<{
    agentModel: Model<any>;
    memoryModel: string;
  }> {
    this.capturedAgentModel = undefined;
    this.capturedMemoryModel = undefined;
    await this.start({ type: "start", mode: "agent", options });
    await this.turn({
      type: "prompt",
      message: "Capture model routing.",
      behavior: "follow_up",
    });
    if (!this.capturedAgentModel || !this.capturedMemoryModel) {
      throw new Error("Expected agent and memory models to be captured");
    }
    return {
      agentModel: this.capturedAgentModel,
      memoryModel: this.capturedMemoryModel,
    };
  }

  protected override async updateMemoryAfterAgentRun(
    _messages: AgentMessage[],
    options: TurnOptions | undefined,
  ): Promise<void> {
    this.capturedMemoryModel = this.resolveMemoryActorModel(options);
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    this.capturedAgentModel = agent.state.model;
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistantMessage({ text: "ok" }),
        });
      });
      return stream;
    };
    return agent;
  }
}

class UsageTrackingTurnRunner extends TurnRunner {
  protected override createMemoryTransform() {
    return async (messages: AgentMessage[]) => {
      this.recordUsage({
        input: 5,
        output: 7,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
      return messages;
    };
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistantMessage({
            text: "ok",
            usage: {
              input: 11,
              output: 13,
              cacheRead: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.15 },
            },
          }),
        });
      });
      return stream;
    };
    return agent;
  }
}

/**
 * End-to-end harness for the `usage` event. Reuses the stream-stubbing
 * pattern from `MemoryEventTurnRunner` so a full `startTurn(...).turn`
 * drives a fake assistant `done` event through the runner, which then
 * triggers `emitParentAgentEvent → emit usage`. Memory is left
 * unconfigured; the breakdown still runs since the cache always returns
 * `{ stored: [], global: [], local: [] }` when no pack has been frozen.
 */
class UsageEventTurnRunner extends TurnRunner {
  /** Messages pushed onto `agent.state.messages` at creation time. */
  seedMessages: AgentMessage[] = [];

  effectiveContextWindowForTest(): number {
    return this.effectiveContextWindow();
  }

  requireParentAgentForTest(): Agent {
    return this.requireParentAgent();
  }

  /** Advance the sticky wire-eviction horizon for tests. */
  setEvictionHorizonForTest(horizon: number): void {
    this.wireGuardHorizon.evictionHorizon = horizon;
  }

  /** Recompute the per-segment context-usage breakdown directly. */
  estimateContextWindowUsageForTest() {
    return this.estimateContextWindowUsage();
  }

  /**
   * Freeze a synthetic pack into the runner's memory cache so the
   * context-usage breakdown has non-empty memory segments without
   * spinning up a real database.
   */
  seedFrozenPackForTest(pack: {
    global: ReturnType<typeof synthObservation>[];
    local: ReturnType<typeof synthObservation>[];
  }) {
    this.memory.setContextPack(pack);
    return pack;
  }

  seedFrozenStoredForTest(content: string): void {
    this.memory.setStoredContextPack([
      {
        slug: "usage",
        storeDir: "/tmp/.agents/memories",
        id: "mem_usage",
        kind: "train",
        createdAt: 1,
        content,
      },
    ]);
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    // No-op: skip the memory pipeline so the turn completes solely
    // through the streamFn stub and never depends on a database.
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    if (this.seedMessages.length > 0) {
      agent.state.messages.push(...this.seedMessages);
    }
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistantMessage({
            text: "ok",
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }),
        });
      });
      return stream;
    };
    return agent;
  }
}

/**
 * Drives `runAgentWorker`'s overflow-recovery branch end-to-end. The
 * stubbed `streamFn` pushes a configurable assistant message per attempt
 * — overflow-flavored or successful — so a single `startTurn(...).turn`
 * call exercises the first-attempt failure plus the optional retry. The
 * runner also pre-seeds `agent.state.messages` between `start` and the
 * actual prompt so the half-history calculation has enough observable
 * messages to drop at least one — `MIN_HISTORY_TAIL=1` clamps the cut
 * to zero when fewer than two messages are evictable.
 */
class OverflowRecoveryTurnRunner extends TurnRunner {
  attempts = 0;
  attemptMessages: AssistantMessage[] = [];
  seedMessages: AgentMessage[] = [];
  capturedAgent?: Agent;

  getEvictionHorizon(): number {
    return this.wireGuardHorizon.evictionHorizon;
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    // Memory pipeline is unrelated to overflow recovery; skip so the
    // turn settles solely through the streamFn stub.
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    this.capturedAgent = agent;
    // Seed history before any prompt runs so the first observable list
    // already exceeds `MIN_HISTORY_TAIL`. The seeded messages are
    // pushed into the live `_state.messages` array, matching the
    // production shape where prior turns accumulate over time.
    if (this.seedMessages.length > 0) {
      agent.state.messages.push(...this.seedMessages);
    }
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const attemptIndex = this.attempts;
      this.attempts += 1;
      const message = this.attemptMessages[attemptIndex] ?? createAssistantMessage({ text: "ok" });
      queueMicrotask(() => {
        if (message.stopReason === "error") {
          // Push as an "error" event so the agent loop routes it through
          // the same `errorMessage`-bearing path real providers use.
          // pi-agent's `streamAssistantResponse` will push the message
          // onto the transcript and emit `turn_end`, which sets
          // `agent.state.errorMessage`.
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }
      });
      return stream;
    };
    return agent;
  }
}

class MemoryEventTurnRunner extends TurnRunner {
  readonly memoryRuns: AgentMessage[][] = [];

  protected override async updateMemoryAfterAgentRun(messages: AgentMessage[]): Promise<void> {
    this.memoryRuns.push([...messages]);
    const raw = messages
      .map(agentMessageToRaw)
      .filter((message): message is NonNullable<typeof message> => Boolean(message));
    const range = `${raw[0]?.id ?? "unknown"}:${raw[raw.length - 1]?.id ?? "unknown"}`;
    // No DB configured for this test runner; mint a synthetic
    // observation and emit it directly so subscribers see the
    // expected memory event shape.
    const now = Date.now();
    const observation = {
      id: `mem_test_${now}`,
      createdAt: now,
      lastUsedAt: now,
      kind: "observation" as const,
      observedDate: "2026-05-08",
      priority: "high" as const,
      source: { kind: "system" } as const,
      content: `<observation-group id="test" range="${range}">\n* ✅ Remembered pi-run memory payload.\n</observation-group>`,
      tags: ["observational-memory"],
    };
    this.emit({
      type: "memory",
      phase: "observation",
      status: "completed",
      message: "Memory observation recorded.",
      observations: [observation],
    });
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistantMessage({ text: "ok" }),
        });
      });
      return stream;
    };
    return agent;
  }
}

describe("TurnRunner memory", () => {
  testIfDocker("loads discovered file memory when database memory is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "duet-runner-stored-memory-"));
    const cwd = join(root, "agent", "work");
    const store = join(root, "agent", ".agents", "memories");
    const runner = new MemoryTransformTurnRunner({
      cwd,
      memoryDbPath: false,
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeEntry(store, {
        slug: "project-facts",
        version: 1,
        id: "mem_project_facts",
        kind: "train",
        createdAt: 1,
        content: "FILE MEMORY WITHOUT A DATABASE",
      });
      await writeFile(join(store, "malformed.md"), "invalid memory file", "utf8");

      await runner.start({ type: "start", mode: "agent" });

      expect(runner.getFrozenContextPackForTest().stored.map((entry) => entry.content)).toEqual([
        "FILE MEMORY WITHOUT A DATABASE",
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("malformed.md");
    } finally {
      warn.mockRestore();
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "reloadSkills refreshes file memory once while ordinary writes leave it frozen",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "duet-runner-refresh-stored-memory-"));
      const cwd = join(root, "agent", "work");
      const store = join(root, "agent", ".agents", "memories");
      const runner = new MemoryTransformTurnRunner({
        cwd,
        memoryDbPath: false,
        model: "anthropic:claude-opus-4-7",
        skillDiscovery: { includeDefaults: false },
      });
      try {
        await writeEntry(store, {
          slug: "refreshable",
          version: 1,
          id: "mem_refreshable",
          kind: "train",
          createdAt: 1,
          content: "BEFORE RELOAD",
        });
        await runner.start({ type: "start", mode: "agent" });
        const transform = runner.createMemoryTransformForTest();
        const messages: AgentMessage[] = [{ role: "user", content: "request", timestamp: 2 }];
        const prefix = async () => {
          const first = (await transform(messages))[0];
          return first && "content" in first ? JSON.stringify(first.content) : "";
        };

        const initial = await prefix();
        await updateEntry(store, "refreshable", "AFTER RELOAD");
        expect(await prefix()).toBe(initial);

        await runner.reloadSkills();
        const refreshed = await prefix();
        expect(refreshed).not.toBe(initial);
        expect(refreshed).toContain("AFTER RELOAD");
        expect(await prefix()).toBe(refreshed);
      } finally {
        await runner.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  testIfDocker("memoryStores false disables discovered file memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "duet-runner-no-stored-memory-"));
    const cwd = join(root, "agent", "work");
    const store = join(root, "agent", ".agents", "memories");
    const runner = new MemoryTransformTurnRunner({
      cwd,
      memoryDbPath: false,
      memoryStores: false,
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    try {
      await writeEntry(store, {
        slug: "must-not-load",
        version: 1,
        id: "mem_must_not_load",
        kind: "train",
        createdAt: 1,
        content: "MUST NOT ENTER CONTEXT",
      });

      await runner.start({ type: "start", mode: "agent" });

      expect(runner.getFrozenContextPackForTest().stored).toEqual([]);
    } finally {
      await runner.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders stored, global, and local memory in that order inside one observations block", async () => {
    const memory = new MemoryContextCache();
    memory.setStoredContextPack([
      {
        slug: "trained-product",
        storeDir: "/project/.agents/memories",
        id: "mem_trained_product",
        kind: "train",
        createdAt: 3,
        headline: "Product facts",
        content: "PINNED STORE CONTENT",
      },
    ]);
    memory.setContextPack({
      global: [synthObservation({ id: "global", content: "GLOBAL OBSERVATION CONTENT" })],
      local: [synthObservation({ id: "local", content: "LOCAL OBSERVATION CONTENT" })],
    });

    const result = await compactObservationalContext({
      messages: [{ role: "user", content: "latest request", timestamp: 4 }],
      memory,
      horizon: createInitialHorizon(),
      targetMessageTokens: 1_000,
    });

    const rendered = JSON.stringify(result[0]);
    expect(rendered).toContain("<observations>");
    expect(rendered).toContain("<stored_observations>");
    expect(rendered).toContain("<global_observations>");
    expect(rendered).toContain("<local_observations>");
    expect(rendered.indexOf("<stored_observations>")).toBeLessThan(
      rendered.indexOf("<global_observations>"),
    );
    expect(rendered.indexOf("<global_observations>")).toBeLessThan(
      rendered.indexOf("<local_observations>"),
    );
    expect(rendered).toContain("PINNED STORE CONTENT");
  });

  test("advisor compaction renders frozen observations above a bounded recent raw tail", async () => {
    const memory = new MemoryContextCache();
    const now = Date.now();
    memory.setContextPack({
      global: [],
      local: [
        {
          id: "mem_advisor_compaction",
          createdAt: now,
          lastUsedAt: now,
          kind: "observation",
          observedDate: "2026-07-21",
          priority: "high",
          source: { kind: "system" },
          content: "OLDER WORK WAS SUMMARIZED HERE",
          tags: ["test"],
        },
      ],
    });
    const old = { role: "user" as const, content: "OLD RAW HISTORY ".repeat(30), timestamp: 1 };
    const recent = { role: "user" as const, content: "RECENT RAW TAIL", timestamp: 2 };
    let drained = false;

    const result = await compactObservationalContext({
      messages: [old, recent],
      memory,
      horizon: createInitialHorizon(),
      targetMessageTokens: 10,
      onCompaction: async () => {
        drained = true;
      },
    });

    expect(drained).toBe(true);
    expect(result).toContain(recent);
    expect(result).not.toContain(old);
    expect(JSON.stringify(result)).toContain("OLDER WORK WAS SUMMARIZED HERE");
  });

  test("advisor compaction keeps the latest complete tool interaction above its soft target", async () => {
    const memory = new MemoryContextCache();
    const toolCall = createAssistantMessage({
      extraContent: [
        {
          type: "toolCall",
          id: "latest-test",
          name: "bash",
          arguments: { command: "bun test" },
        },
      ],
      timestamp: 2,
    });
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "latest-test",
      toolName: "bash",
      content: [{ type: "text", text: "LATEST COMPLETE TEST RESULT ".repeat(30) }],
      details: { exitCode: 0 },
      isError: false,
      timestamp: 3,
    };
    const review = createAssistantMessage({ text: "Ask the advisor.", timestamp: 4 });
    const old = { role: "user" as const, content: "OLD RAW HISTORY ".repeat(30), timestamp: 1 };

    const result = await compactObservationalContext({
      messages: [old, toolCall, toolResult, review],
      memory,
      horizon: createInitialHorizon(),
      targetMessageTokens: 10,
      protectRecentToolInteraction: true,
    });

    expect(result).not.toContain(old);
    expect(result).toContain(toolCall);
    expect(result).toContain(toolResult);
    expect(result).toContain(review);
  });

  test("observational transform does not persist raw messages below observation threshold", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const transform = runner.createMemoryTransformForTest();
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Remember that the launch flag is called beta_checkout." }],
        timestamp: 1,
      },
    ];

    await transform(messages);

    // Pack stays empty because the transform never refreshes it on
    // its own — only compaction events do, and none fire below
    // threshold.
    expect(runner.getFrozenContextPackForTest()).toEqual({ stored: [], global: [], local: [] });
  });

  test("observational transform only shapes context at compaction threshold", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      // E=17 → messageTokens≈10, bufferActivation≈5. A 100-char (25-token)
      // user message clears the compaction trigger; eviction reduces the
      // tail to ≤bufferActivation, leaving the transform output empty since
      // no memory pack is loaded.
      effectiveContext: 17,
    });
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));
    const transform = runner.createMemoryTransformForTest();

    const transformed = await transform([
      {
        role: "user",
        content: [{ type: "text", text: "x".repeat(100) }],
        timestamp: 1,
      },
    ]);

    expect(events.filter((event) => (event as { type?: string }).type === "memory")).toEqual([]);
    expect(transformed.length).toBeLessThanOrEqual(1);
  });

  test("observational transform waits for a full new suffix after first observation", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      // E=34 → messageTokens≈20, bufferActivation≈10. Reflection budgets are
      // irrelevant here; the transform never runs the reflector.
      effectiveContext: 34,
    });
    await runner.seedFrozenObservationForTest(
      '<observation-group id="test" range="msg_assistant_observed:msg_assistant_observed">\n* 🔴 Already observed the long message.\n</observation-group>',
    );
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));
    const transform = runner.createMemoryTransformForTest();
    const messages: AgentMessage[] = [
      {
        ...createAssistantMessage({ text: "x".repeat(100), timestamp: 1 }),
        responseId: "observed",
      },
      {
        role: "user",
        content: [{ type: "text", text: "tiny follow-up" }],
        timestamp: 2,
      },
    ];

    const transformed = await transform(messages);

    expect(events.filter((event) => (event as { type?: string }).type === "memory")).toEqual([]);
    expect(transformed).toHaveLength(3);
    expect(transformed.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "tiny follow-up" }],
    });
  });

  test("raw memory keeps image-only messages with compact text previews", () => {
    const imageData = "base64-image-payload".repeat(100);
    const image: ImageContent = {
      type: "image",
      mimeType: "image/png",
      data: imageData,
    };
    const message: AgentMessage = {
      role: "user",
      content: [image],
      timestamp: 1,
    };
    const raw = agentMessageToRaw(message);

    expect(raw).toBeDefined();
    expect(raw?.content).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: imageData,
      },
    ]);
    expect(raw?.textPreview).toContain("[image:");
    expect(raw?.textPreview).toContain("image/png");
    expect(raw?.textPreview).toContain("source=data omitted");
    expect(raw?.textPreview).not.toContain(imageData);
    expect(raw?.id).not.toContain(imageData);
    expect(raw?.estimatedTokens).toBeGreaterThanOrEqual(1_600);
    expect(raw?.estimatedTokens).toBeLessThan(1_625);
  });

  test("observer prompt places image blocks next to their message boundary", () => {
    const image: ImageContent = {
      type: "image",
      mimeType: "image/png",
      data: "opaque-image-bytes",
    };
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Please inspect this UI." }, image],
      timestamp: 1,
    };
    const raw = agentMessageToRaw(message);

    expect(raw).toBeDefined();
    const prompt = buildObserverPrompt(
      [raw!],
      "",
      100,
      undefined,
      new Date("2026-05-07T10:00:00Z"),
    );
    const text = prompt
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    expect(prompt.some((part) => part.type === "image")).toBe(true);
    expect(text).toContain("USER");
    expect(text).toContain(raw!.id);
    expect(text).toContain("Please inspect this UI.");
    expect(text).toContain("[image:");
    expect(text).not.toContain("opaque-image-bytes");
  });

  test("observation ranges, not no-op passes, advance observed message progress", () => {
    const observed = {
      ...createAssistantMessage({ text: "Observed result", timestamp: 1 }),
      responseId: "observed",
    };
    const later = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "low-signal context for later" }],
      timestamp: 2,
    };
    const raw = [observed, later]
      .map(agentMessageToRaw)
      .filter((message): message is NonNullable<typeof message> => Boolean(message));

    expect(
      getUnobservedMessageTail(raw, [
        {
          id: "mem_test",
          createdAt: 1,
          lastUsedAt: 1,
          kind: "observation",
          observedDate: "2026-05-08",
          priority: "high",
          source: { kind: "system" },
          content:
            '<observation-group id="test" range="msg_assistant_observed:msg_assistant_observed">\n* ✅ Observed result.\n</observation-group>',
          tags: ["observational-memory"],
        },
      ]).map((message) => message.textPreview),
    ).toEqual(["low-signal context for later"]);

    expect(getUnobservedMessageTail(raw, []).map((message) => message.textPreview)).toEqual([
      "Observed result",
      "low-signal context for later",
    ]);
  });

  test("trimMessagesToTranscriptBudget keeps newest messages and partially includes the boundary", () => {
    // Each whole message: 400 chars of text → 100 estimated tokens
    // under the ceil(len/4) heuristic. Use a token budget that lands
    // partway through one of them to exercise the boundary slice.
    const makeMessage = (
      index: number,
    ): {
      id: string;
      createdAt: number;
      role: "user";
      content: { type: "text"; text: string }[];
      textPreview: string;
      estimatedTokens: number;
    } => {
      const text = `m${index}-${"x".repeat(400 - `m${index}-`.length)}`;
      return {
        id: `msg_${index}`,
        createdAt: index,
        role: "user",
        content: [{ type: "text", text }],
        textPreview: text,
        estimatedTokens: 100,
      };
    };
    const messages = Array.from({ length: 5 }, (_, index) => makeMessage(index));

    const fits = trimMessagesToTranscriptBudget(messages, 200);
    expect(fits.map((m) => m.id)).toEqual(["msg_3", "msg_4"]);
    expect(fits.map((m) => m.textPreview)).toEqual([
      messages[3]!.textPreview,
      messages[4]!.textPreview,
    ]);

    // Budget = 280 tokens: msg_4 (100) + msg_3 (100) fit whole; msg_2
    // gets 80 remaining tokens (~320 chars minus the marker), which is
    // above the partial boundary threshold so it's included partially.
    const partial = trimMessagesToTranscriptBudget(messages, 280);
    expect(partial.map((m) => m.id)).toEqual(["msg_2", "msg_3", "msg_4"]);
    expect(partial[0]!.textPreview.startsWith("[… older content trimmed]")).toBe(true);
    expect(partial[0]!.textPreview.length).toBeLessThan(messages[2]!.textPreview.length);
    expect(partial[0]!.textPreview.endsWith(messages[2]!.textPreview.slice(-20))).toBe(true);
    expect(partial[1]).toBe(messages[3]!);
    expect(partial[2]).toBe(messages[4]!);

    // Budget = 250 tokens: msg_4 + msg_3 fit; msg_2's remaining slice
    // (~50 tokens = ~200 chars, minus marker) falls below the partial
    // threshold, so the boundary is dropped entirely.
    const tooSmallForPartial = trimMessagesToTranscriptBudget(messages, 250);
    expect(tooSmallForPartial.map((m) => m.id)).toEqual(["msg_3", "msg_4"]);

    expect(trimMessagesToTranscriptBudget(messages, 500).map((m) => m.id)).toEqual([
      "msg_0",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
    ]);
    expect(trimMessagesToTranscriptBudget([], 100)).toEqual([]);
    expect(trimMessagesToTranscriptBudget(messages, 0)).toEqual([]);
    // Budget smaller than the marker overhead: no partial worth keeping.
    expect(trimMessagesToTranscriptBudget(messages, 1)).toEqual([]);
  });

  test("memory event payloads are emitted after a pi-agent run below compaction threshold", async () => {
    const runner = new MemoryEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "Remember beta_checkout." })
    ).turn;
    const memoryEvents = events.filter((event) => event.type === "memory");
    const terminalIndex = events.indexOf(terminal);
    let lastMemoryIndex = -1;
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]?.type === "memory") {
        lastMemoryIndex = index;
        break;
      }
    }

    expect(runner.memoryRuns).toHaveLength(1);
    expect(memoryEvents).toHaveLength(1);
    expect(memoryEvents[0]).toMatchObject({
      type: "memory",
      phase: "observation",
      status: "completed",
      message: "Memory observation recorded.",
      observations: [
        expect.objectContaining({
          content: expect.stringContaining("Remembered pi-run memory payload."),
        }),
      ],
    });
    expect(lastMemoryIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(lastMemoryIndex);
    expect(terminal.state.agent.messages.length).toBeGreaterThan(0);
  });

  test("resolveTurnOptions falls back through turn → state base → config → default", () => {
    const configured = new TurnRunner({
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "high",
      skillDiscovery: { includeDefaults: false },
    });
    expect(configured.resolveTurnOptions()).toMatchObject({
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    expect(
      configured.resolveTurnOptions(undefined, { model: "anthropic:claude-3-haiku-20240307" }),
    ).toMatchObject({ model: "anthropic:claude-3-haiku-20240307", thinkingLevel: "high" });
    expect(
      configured.resolveTurnOptions(
        { model: "anthropic:claude-opus-4-7", thinkingLevel: "low" },
        { model: "anthropic:claude-3-haiku-20240307" },
      ),
    ).toMatchObject({ model: "anthropic:claude-opus-4-7", thinkingLevel: "low" });

    const unconfigured = new TurnRunner({ skillDiscovery: { includeDefaults: false } });
    expect(unconfigured.resolveTurnOptions()).toMatchObject({
      model: "opus-4.8",
      thinkingLevel: undefined,
    });
  });

  test("resolveMemoryActorModel falls back through turn → config → default", () => {
    const configured = new TurnRunner({
      model: "anthropic:claude-opus-4-7",
      memoryModel: "anthropic:claude-3-5-haiku-latest",
      skillDiscovery: { includeDefaults: false },
    });
    expect(configured.resolveMemoryActorModel(undefined)).toBe("anthropic:claude-3-5-haiku-latest");
    expect(
      configured.resolveMemoryActorModel({ memoryModel: "anthropic:claude-3-haiku-20240307" }),
    ).toBe("anthropic:claude-3-haiku-20240307");

    const unconfigured = new TurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    expect(unconfigured.resolveMemoryActorModel(undefined)).toBe("gpt-5.6-luna");
  });

  test("routes turn and memory model overrides independently", async () => {
    const runner = new ModelRoutingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });

    const withAgentOverride = await runner.captureModels({
      model: "anthropic:claude-sonnet-4-5",
    });
    expect(withAgentOverride.agentModel.id).toBe("claude-sonnet-4-5");
    expect(withAgentOverride.memoryModel).toBe("gpt-5.6-luna");

    const withConfiguredMemoryOverride = await new ModelRoutingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      memoryModel: "haiku-4.5",
      skillDiscovery: { includeDefaults: false },
    }).captureModels();
    expect(withConfiguredMemoryOverride.agentModel.id).toBe("claude-opus-4-7");
    expect(withConfiguredMemoryOverride.memoryModel).toBe("haiku-4.5");

    const withMemoryOverride = await runner.captureModels({
      model: "anthropic:claude-sonnet-4-5",
      memoryModel: "anthropic:claude-3-5-haiku-latest",
    });
    expect(withMemoryOverride.agentModel.id).toBe("claude-sonnet-4-5");
    expect(withMemoryOverride.memoryModel).toBe("anthropic:claude-3-5-haiku-latest");
  });

  test("includes memory operation usage in emitted terminal usage", async () => {
    const runner = new UsageTrackingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "Check usage." })
    ).turn;

    expect(terminal.turnUsage).toEqual({
      input: 16,
      output: 20,
      totalTokens: 36,
      cacheRead: 5,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.18 },
    });
    expect(events.at(-1)).toMatchObject({ turnUsage: terminal.turnUsage });
  });

  test("memory output budget retries once when over budget", async () => {
    let retryTokens: number | undefined;

    const result = await enforceObservationTokenBudget({
      text: "x".repeat(100),
      targetTokens: 10,
      retry: async (actualTokens) => {
        retryTokens = actualTokens;
        return "short";
      },
    });

    expect(retryTokens).toBe(Math.ceil(100 / CHARS_PER_TOKEN));
    expect(result).toBe("short");
  });

  test("memory output budget hard trims when retry remains over budget", async () => {
    const result = await enforceObservationTokenBudget({
      text: "x".repeat(100),
      targetTokens: 10,
      retry: async () => "y".repeat(100),
    });

    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain("y");
  });

  test("sticky horizon reuses the same eviction across consecutive transform calls", async () => {
    // Tiny token budget so the trigger fires immediately; the test then
    // confirms the second call does not advance the horizon further when
    // the input has not grown past the existing cut.
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      // E=34 → messageTokens≈20, bufferActivation≈10. The 80-char (20-token)
      // first message triggers eviction; the second call must reuse the same
      // sticky horizon when input is unchanged.
      effectiveContext: 34,
    });
    const transform = runner.createMemoryTransformForTest();
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(80) }], timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "latest prompt" }], timestamp: 2 },
    ];

    const firstPass = await transform(messages);
    const secondPass = await transform(messages);

    // The dispatched lists must be content-equivalent across turns when the
    // input does not change — that is the whole point of the sticky horizon.
    expect(secondPass.length).toBe(firstPass.length);
    for (let i = 0; i < firstPass.length; i++) {
      expect((secondPass[i] as { content: unknown }).content).toEqual(
        (firstPass[i] as { content: unknown }).content,
      );
    }
    // Latest prompt always survives.
    expect(firstPass.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "latest prompt" }],
    });
  });

  test("effectiveContextWindow clamps a user value larger than the model window to the model window", async () => {
    const runner = new UsageEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      effectiveContext: 10_000_000,
    });
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "ping" });
    await turn;

    const modelWindow = runner.requireParentAgentForTest().state.model.contextWindow;
    expect(runner.effectiveContextWindowForTest()).toBe(modelWindow);
    expect(modelWindow).toBeLessThan(10_000_000);
  });

  test("effectiveContextWindow uses the user value when it fits inside the model window", async () => {
    const runner = new UsageEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      effectiveContext: 50_000,
    });
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "ping" });
    await turn;

    const modelWindow = runner.requireParentAgentForTest().state.model.contextWindow;
    expect(modelWindow).toBeGreaterThan(50_000);
    expect(runner.effectiveContextWindowForTest()).toBe(50_000);
  });

  test("provider context-overflow on first attempt advances the wire horizon and retries once", async () => {
    const runner = new OverflowRecoveryTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    runner.seedMessages = [
      { role: "user", content: [{ type: "text", text: "first user message" }], timestamp: 1 },
      createAssistantMessage({ text: "first assistant reply", timestamp: 2 }),
      { role: "user", content: [{ type: "text", text: "second user message" }], timestamp: 3 },
      createAssistantMessage({ text: "second assistant reply", timestamp: 4 }),
    ];
    runner.attemptMessages = [
      createAssistantMessage({
        stopReason: "error",
        errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
        timestamp: 5,
      }),
      createAssistantMessage({ text: "recovered after compaction", timestamp: 6 }),
    ];
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "ping after seeded history" })
    ).turn;

    expect(runner.attempts).toBe(2);
    expect(terminal.type).toBe("complete");
    if (terminal.type !== "complete") throw new Error("expected complete terminal");
    expect(terminal.status).toBe("completed");
    expect(terminal.result).toBe("recovered after compaction");

    expect(runner.getEvictionHorizon()).toBeGreaterThan(0);
    const agent = runner.capturedAgent;
    if (!agent) throw new Error("expected captured parent agent");
    expect(agent.state.errorMessage).toBeUndefined();
    // No failure-message marker should remain in the transcript after
    // recovery popped it.
    expect(
      agent.state.messages.some(
        (msg) => msg.role === "assistant" && (msg as { errorMessage?: string }).errorMessage,
      ),
    ).toBe(false);
    // `agent.continue()` resumes from the existing user message instead
    // of appending a duplicate, so exactly one user message carries the
    // current prompt's text in the post-recovery transcript.
    const promptUserMessages = agent.state.messages.filter(
      (msg) =>
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            (part as { text: string }).text === "ping after seeded history",
        ),
    );
    expect(promptUserMessages).toHaveLength(1);

    const noticeEvents = events.filter(
      (event): event is Extract<TurnEvent, { type: "system" }> =>
        event.type === "system" && event.message.startsWith("Context overflow"),
    );
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]!.level).toBe("info");
    expect(noticeEvents[0]!.message).toMatch(/dropped \d+ older message/);
  });

  test("provider context-overflow on both attempts fails after exactly one retry", async () => {
    const runner = new OverflowRecoveryTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    runner.seedMessages = [
      { role: "user", content: [{ type: "text", text: "u1" }], timestamp: 1 },
      createAssistantMessage({ text: "a1", timestamp: 2 }),
      { role: "user", content: [{ type: "text", text: "u2" }], timestamp: 3 },
      createAssistantMessage({ text: "a2", timestamp: 4 }),
    ];
    const overflowMessage = (timestamp: number) =>
      createAssistantMessage({
        stopReason: "error",
        errorMessage: "prompt is too long: still over the limit after compaction",
        timestamp,
      });
    runner.attemptMessages = [overflowMessage(5), overflowMessage(6)];
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "ping that overflows twice" })
    ).turn;

    expect(runner.attempts).toBe(2);
    expect(terminal.type).toBe("complete");
    if (terminal.type !== "complete") throw new Error("expected complete terminal");
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("prompt is too long");
    expect(
      events.filter(
        (event) => event.type === "system" && event.message.startsWith("Context overflow"),
      ),
    ).toHaveLength(1);
  });

  test("non-overflow provider error does not retry and leaves the wire horizon unchanged", async () => {
    const runner = new OverflowRecoveryTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    runner.seedMessages = [
      { role: "user", content: [{ type: "text", text: "u1" }], timestamp: 1 },
      createAssistantMessage({ text: "a1", timestamp: 2 }),
      { role: "user", content: [{ type: "text", text: "u2" }], timestamp: 3 },
      createAssistantMessage({ text: "a2", timestamp: 4 }),
    ];
    // Pick a client-side error so neither the context-overflow path nor
    // the transient-error retry path triggers. A 401 will not be retried
    // because the same payload would fail again on a second attempt.
    runner.attemptMessages = [
      createAssistantMessage({
        stopReason: "error",
        errorMessage: "401 Unauthorized: invalid API key",
        timestamp: 5,
      }),
    ];
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (
      await startTurn(runner, { mode: "agent", prompt: "ping that hits a non-overflow error" })
    ).turn;

    expect(runner.attempts).toBe(1);
    expect(terminal.type).toBe("complete");
    if (terminal.type !== "complete") throw new Error("expected complete terminal");
    expect(terminal.status).toBe("failed");
    expect(runner.getEvictionHorizon()).toBe(0);
    expect(
      events.filter(
        (event) => event.type === "system" && event.message.startsWith("Context overflow"),
      ),
    ).toHaveLength(0);
  });

  test("attributes pinned store tokens to the existing globalMemory segment", async () => {
    const runner = new UsageEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      memoryStores: false,
      skillDiscovery: { includeDefaults: false },
    });
    await runner.start({ type: "start", mode: "agent" });
    try {
      const before = runner.estimateContextWindowUsageForTest();
      const content = "pinned usage telemetry";
      runner.seedFrozenStoredForTest(content);
      const after = runner.estimateContextWindowUsageForTest();

      expect(after.globalMemory - before.globalMemory).toBe(
        Math.ceil(content.length / CHARS_PER_TOKEN),
      );
      expect(after.localMemory).toBe(before.localMemory);
    } finally {
      await runner.dispose();
    }
  });

  test("usage event carries a contextWindowUsage breakdown that scales with inputs", async () => {
    const runner = new UsageEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      systemInstructions:
        "Detailed test system instructions that should grow the system prompt segment beyond the base prompt alone.",
    });
    const seeded = runner.seedFrozenPackForTest({
      global: [
        synthObservation({
          id: "global-1",
          content: "Cross-session memory about the deploy command pnpm deploy:prod.",
        }),
        synthObservation({
          id: "global-2",
          content: "Cross-session memory about user preferences for terse answers.",
        }),
      ],
      local: [
        synthObservation({
          id: "local-1",
          content: "This session: the user asked about the api service deploy flow.",
        }),
      ],
    });

    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const { turn } = await startTurn(runner, { mode: "agent", prompt: "ping" });
    await turn;

    const usageEvent = events.find(
      (event): event is Extract<TurnEvent, { type: "usage" }> => event.type === "usage",
    );
    expect(usageEvent).toBeDefined();
    if (!usageEvent) throw new Error("expected usage after completion");
    expect(usageEvent.effectiveContextWindow).toBe(runner.effectiveContextWindowForTest());

    const breakdown = usageEvent.contextWindowUsage;
    expect(breakdown.systemPrompt).toBeGreaterThan(0);
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.localMemory).toBeGreaterThan(0);
    expect(breakdown.globalMemory).toBeGreaterThan(0);

    // The breakdown is rescaled to the latest parent message's
    // `totalTokens`, so its segments sum exactly to `lastMessageUsage.totalTokens`.
    const total =
      breakdown.systemPrompt + breakdown.messages + breakdown.localMemory + breakdown.globalMemory;
    expect(total).toBe(usageEvent.lastMessageUsage.totalTokens);

    // The two global rows together should contribute more tokens than
    // the single local row, since their combined content is longer.
    expect(breakdown.globalMemory).toBeGreaterThan(breakdown.localMemory);

    // Raw estimates (before scaling) should still reflect pack sizes:
    // global content is longer than local, so the scaled global segment
    // should still exceed the scaled local segment by a healthy margin.
    const expectedGlobalRaw = seeded.global.reduce(
      (sum, row) => sum + Math.ceil(row.content.length / CHARS_PER_TOKEN),
      0,
    );
    const expectedLocalRaw = seeded.local.reduce(
      (sum, row) => sum + Math.ceil(row.content.length / CHARS_PER_TOKEN),
      0,
    );
    expect(expectedGlobalRaw).toBeGreaterThan(expectedLocalRaw);
  });

  test("usage event from a recovered overflow turn reflects the post-eviction message tail end-to-end", async () => {
    // Integration shape: a real provider context-overflow on the first
    // attempt advances `wireGuardHorizon` past the oldest seeded
    // messages; the second attempt succeeds and emits a `usage` event
    // whose `contextWindowUsage.messages` segment must reflect only
    // the surviving tail, not the runner-retained full transcript.
    const runner = new OverflowRecoveryTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const huge = "x".repeat(10_000);
    const tiny = "kept";
    runner.seedMessages = [
      { role: "user", content: [{ type: "text", text: huge }], timestamp: 1 },
      createAssistantMessage({ text: huge, timestamp: 2 }),
      { role: "user", content: [{ type: "text", text: tiny }], timestamp: 1000 },
      createAssistantMessage({ text: tiny, timestamp: 1001 }),
    ];
    // First attempt overflows; second attempt succeeds and carries a
    // known totalTokens so the scaled bar segments are predictable.
    runner.attemptMessages = [
      createAssistantMessage({
        stopReason: "error",
        errorMessage: "prompt is too long: 999999 tokens > 200000 maximum",
        timestamp: 5,
      }),
      createAssistantMessage({
        text: "recovered",
        timestamp: 6,
        usage: { input: 1500, output: 0, totalTokens: 1500 },
      }),
    ];
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await (await startTurn(runner, { mode: "agent", prompt: "recover" })).turn;
    expect(terminal.type).toBe("complete");
    if (terminal.type !== "complete") throw new Error("expected complete terminal");
    expect(terminal.status).toBe("completed");

    // Eviction horizon advanced past the huge prefix on retry.
    expect(runner.getEvictionHorizon()).toBeGreaterThan(0);

    const usageEvent = events.find(
      (event): event is Extract<TurnEvent, { type: "usage" }> => event.type === "usage",
    );
    expect(usageEvent).toBeDefined();
    if (!usageEvent) throw new Error("expected usage after completion");
    const breakdown = usageEvent.contextWindowUsage;

    // Pre-eviction the huge prefix would dominate: with raw
    // messages ≈ 5000 tokens against systemPrompt ≈ 1500-2000 tokens
    // and totalTokens=1500, scaled messages would land near ~1100.
    // Post-eviction the tail is ~50 chars total, so scaled messages
    // collapses well under 200. Using 300 as the upper bound keeps
    // headroom for system-prompt drift without letting a pre-eviction
    // regression slip through.
    expect(breakdown.messages).toBeLessThan(300);
    // System prompt must remain a non-trivial share of the bar after
    // eviction — the bug we are guarding against collapsed it to
    // ~600 against a 53k totalTokens, i.e. ~1% of total. With a 1500
    // totalTokens cap, a healthy systemPrompt segment lands above 100.
    expect(breakdown.systemPrompt).toBeGreaterThan(100);
    // Segments sum exactly to lastMessageUsage.totalTokens.
    expect(
      breakdown.systemPrompt + breakdown.messages + breakdown.localMemory + breakdown.globalMemory,
    ).toBe(usageEvent.lastMessageUsage.totalTokens);
  });

  test("contextWindowUsage messages segment excludes bytes dropped by the wire-eviction horizon", async () => {
    const runner = new UsageEventTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const longText = "x".repeat(4000);
    runner.seedMessages = [
      { role: "user", content: [{ type: "text", text: `pre-eviction ${longText}` }], timestamp: 1 },
      createAssistantMessage({ text: `pre-eviction reply ${longText}`, timestamp: 2 }),
      { role: "user", content: [{ type: "text", text: `kept ${longText}` }], timestamp: 1000 },
      createAssistantMessage({ text: `kept reply ${longText}`, timestamp: 1001 }),
    ];

    const { turn } = await startTurn(runner, { mode: "agent", prompt: "ping" });
    await turn;

    const before = runner.estimateContextWindowUsageForTest();

    // Advance the horizon past the first two seeded messages. The
    // dispatched slice loses those bytes; the runner's retained
    // transcript still contains them.
    runner.setEvictionHorizonForTest(2);
    const after = runner.estimateContextWindowUsageForTest();

    expect(after.messages).toBeLessThan(before.messages);
    // The two dropped messages each contained ~4000 chars of text, so
    // the difference should be at least ~1000 tokens (4 chars/token).
    expect(before.messages - after.messages).toBeGreaterThan(1000);
    // System prompt and memory packs are unaffected by the horizon.
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.localMemory).toBe(before.localMemory);
    expect(after.globalMemory).toBe(before.globalMemory);
  });
});

describe("scaleContextWindowUsageToTotalTokens", () => {
  test("splits the target across segments with per-slice minimums when the budget allows", () => {
    const scaled = scaleContextWindowUsageToTotalTokens(
      { systemPrompt: 10, messages: 20, localMemory: 5, globalMemory: 5 },
      41,
    );
    expect(scaled.systemPrompt + scaled.messages + scaled.localMemory + scaled.globalMemory).toBe(
      41,
    );
    expect(scaled.systemPrompt).toBe(10);
    expect(scaled.messages).toBe(19);
    expect(scaled.localMemory).toBe(6);
    expect(scaled.globalMemory).toBe(6);
  });

  test("when every raw segment is zero, attributes the full total to messages", () => {
    expect(
      scaleContextWindowUsageToTotalTokens(
        { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 },
        99,
      ),
    ).toEqual({ systemPrompt: 0, messages: 99, localMemory: 0, globalMemory: 0 });
  });

  test("zero target clears every segment", () => {
    expect(
      scaleContextWindowUsageToTotalTokens(
        { systemPrompt: 100, messages: 200, localMemory: 50, globalMemory: 25 },
        0,
      ),
    ).toEqual({ systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 });
  });
});

interface SynthObservationInput {
  id: string;
  content: string;
}

function synthObservation(input: SynthObservationInput) {
  const now = Date.now();
  return {
    id: input.id,
    createdAt: now,
    lastUsedAt: now,
    kind: "observation" as const,
    observedDate: "2026-05-09",
    priority: "high" as const,
    source: { kind: "system" } as const,
    content: input.content,
    tags: ["test"],
  };
}
