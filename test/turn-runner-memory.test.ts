import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import { includeToolPairMessages } from "../src/memory/observational.js";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnOptions } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

class MemoryTransformTurnRunner extends TurnRunner {
  createMemoryTransformForTest(model: Model<any>) {
    return this.createMemoryTransform(model);
  }

  getMemorySnapshotForTest() {
    return this.memory.getSnapshot();
  }
}

class ModelRoutingTurnRunner extends TurnRunner {
  captureModels(options?: TurnOptions): {
    agentModel: Model<any>;
    memoryModel: Model<any>;
  } {
    return {
      agentModel: this.resolveTurnModel(options),
      memoryModel: this.resolveMemoryModel(options),
    };
  }
}

class UsageTrackingTurnRunner extends TurnRunner {
  protected override createMemoryTransform(_model: Model<any>) {
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
    input: AgentWorkerInput,
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
    const transform = runner.createMemoryTransformForTest({
      provider: "unknown",
      id: "test",
    } as Model<any>);
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

  test("routes turn and memory model overrides independently", () => {
    const runner = new ModelRoutingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });

    const withAgentOverride = runner.captureModels({
      model: "anthropic:claude-sonnet-4-5",
    });
    expect(withAgentOverride.agentModel.id).toBe("claude-sonnet-4-5");
    expect(withAgentOverride.memoryModel.id).toBe("claude-opus-4-7");

    const withConfiguredMemoryOverride = new ModelRoutingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      memoryModel: "anthropic:claude-haiku-4-5",
      skillDiscovery: { includeDefaults: false },
    }).captureModels();
    expect(withConfiguredMemoryOverride.agentModel.id).toBe("claude-opus-4-7");
    expect(withConfiguredMemoryOverride.memoryModel.id).toBe("claude-haiku-4-5");

    const withMemoryOverride = runner.captureModels({
      model: "anthropic:claude-sonnet-4-5",
      memoryModel: "anthropic:claude-3-5-haiku-latest",
    });
    expect(withMemoryOverride.agentModel.id).toBe("claude-sonnet-4-5");
    expect(withMemoryOverride.memoryModel.id).toBe("claude-3-5-haiku-latest");
  });

  test("includes memory operation usage in emitted terminal usage", async () => {
    const runner = new UsageTrackingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const events: unknown[] = [];
    runner.subscribe((event) => events.push(event));

    const terminal = await runner.turn({
      type: "start",
      prompt: "Check usage.",
      mode: "agent",
    });

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
});
