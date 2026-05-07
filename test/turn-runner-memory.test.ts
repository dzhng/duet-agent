import { describe, expect, test } from "bun:test";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
} from "@mariozechner/pi-ai";
import {
  agentMessageToRaw,
  enforceObservationTokenBudget,
  includeToolPairMessages,
} from "../src/memory/observational.js";
import { buildObserverPrompt } from "../src/memory/observational-prompts.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnOptions } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

class MemoryTransformTurnRunner extends TurnRunner {
  createMemoryTransformForTest(model: string) {
    return this.createMemoryTransform(model);
  }

  getMemorySnapshotForTest() {
    return this.memory.getSnapshot();
  }

  appendObservationForTest(content: string) {
    return this.memory.appendObservation({
      observedDate: "2026-05-06",
      priority: "high",
      scope: "session",
      source: { kind: "system" },
      content,
      tags: ["test"],
    });
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

  protected override createMemoryTransform(model: string) {
    this.capturedMemoryModel = model;
    return async (messages: AgentMessage[]) => messages;
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
  protected override createMemoryTransform(_model: string) {
    return async (messages: AgentMessage[]) => {
      this.recordUsage({
        inputTokens: 5,
        outputTokens: 7,
        cachedInputTokens: 2,
        costUsd: 0.03,
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

describe("TurnRunner memory", () => {
  test("observational transform does not persist raw messages below observation threshold", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const transform = runner.createMemoryTransformForTest("anthropic:claude-opus-4-7");
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Remember that the launch flag is called beta_checkout." }],
        timestamp: 1,
      },
    ];

    await transform(messages);

    const snapshot = await runner.getMemorySnapshotForTest();
    expect(snapshot).toMatchObject({
      observations: [],
      estimatedTokens: { observations: 0 },
    });
  });

  test("observational transform emits memory activity events", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      memory: {
        observation: {
          messageTokens: 10,
          bufferActivation: 1,
          maxTokensPerBatch: 10,
        },
      },
    });
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));
    const transform = runner.createMemoryTransformForTest("anthropic:claude-opus-4-7");

    await expect(
      transform([
        {
          role: "user",
          content: [{ type: "text", text: "x".repeat(100) }],
          timestamp: 1,
        },
      ]),
    ).rejects.toThrow();

    expect(events.filter((event) => (event as { type?: string }).type === "memory")).toEqual([
      {
        type: "memory",
        phase: "observation",
        status: "running",
        message: "Compacting conversation into memory...",
      },
      {
        type: "memory",
        phase: "observation",
        status: "completed",
        message: "Memory observation complete.",
      },
    ]);
  });

  test("observational transform waits for a full new suffix after first observation", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      memory: {
        observation: {
          messageTokens: 20,
          bufferActivation: 10,
        },
        reflection: {
          observationTokens: 1_000,
          bufferActivation: 500,
        },
      },
    });
    await runner.appendObservationForTest(
      '<observation-group id="test" range="msg_assistant_observed:msg_assistant_observed">\n* 🔴 Already observed the long message.\n</observation-group>',
    );
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));
    const transform = runner.createMemoryTransformForTest("anthropic:claude-opus-4-7");
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
    expect(raw?.estimatedTokens).toBeLessThan(20);
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

  test("observational transform emits reflection activity events", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      memory: {
        observation: {
          messageTokens: 1_000,
          bufferActivation: 100,
        },
        reflection: {
          observationTokens: 10,
          bufferActivation: 5,
        },
      },
    });
    await runner.appendObservationForTest("x".repeat(100));
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));
    const transform = runner.createMemoryTransformForTest("anthropic:claude-opus-4-7");

    await expect(
      transform([
        {
          role: "user",
          content: [{ type: "text", text: "below observation threshold" }],
          timestamp: 1,
        },
      ]),
    ).rejects.toThrow();

    expect(events.filter((event) => (event as { type?: string }).type === "memory")).toEqual([
      {
        type: "memory",
        phase: "reflection",
        status: "running",
        message: "Reflecting memory observations...",
      },
      {
        type: "memory",
        phase: "reflection",
        status: "completed",
        message: "Memory reflection complete.",
      },
    ]);
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
    expect(withAgentOverride.memoryModel).toBe("anthropic:claude-haiku-4-5");

    const withConfiguredMemoryOverride = await new ModelRoutingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      memoryModel: "anthropic:claude-haiku-4-5",
      skillDiscovery: { includeDefaults: false },
    }).captureModels();
    expect(withConfiguredMemoryOverride.agentModel.id).toBe("claude-opus-4-7");
    expect(withConfiguredMemoryOverride.memoryModel).toBe("anthropic:claude-haiku-4-5");

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
      inputTokens: 16,
      outputTokens: 20,
      cachedInputTokens: 5,
      costUsd: 0.18,
    });
    expect(events.at(-1)).toMatchObject({ usage: terminal.usage });
  });

  test("retained tool results keep their matching assistant tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_123",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
        api: "anthropic-messages",
        provider: "vercel-ai-gateway",
        model: "anthropic/claude-opus-4.7",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        responseId: "response_123",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_123",
        toolName: "bash",
        content: [{ type: "text", text: "/repo" }],
        isError: false,
        timestamp: 2,
      },
    ];
    const retainedIds = new Set(["msg_tool_toolu_123"]);

    includeToolPairMessages(messages, retainedIds);

    expect([...retainedIds].sort()).toEqual(["msg_assistant_response_123", "msg_tool_toolu_123"]);
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
});
