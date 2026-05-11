import { describe, expect, test } from "bun:test";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  agentMessageToRaw,
  enforceObservationTokenBudget,
  getUnobservedMessageTail,
} from "../src/memory/observational.js";
import { buildObserverPrompt } from "../src/memory/observational-prompts.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnEvent, TurnOptions } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

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
    expect(runner.getFrozenContextPackForTest()).toEqual({ global: [], local: [] });
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
      model: "opus-4.7",
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
    expect(unconfigured.resolveMemoryActorModel(undefined)).toBe("haiku-4.5");
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
    expect(withAgentOverride.memoryModel).toBe("haiku-4.5");

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

    expect(terminal.usage).toEqual({
      input: 16,
      output: 20,
      totalTokens: 36,
      cacheRead: 5,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.18 },
    });
    expect(events.at(-1)).toMatchObject({ usage: terminal.usage });
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

    expect(retryTokens).toBe(25);
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
});
