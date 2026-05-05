import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { includeToolPairMessages } from "../src/memory/observational.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";

class MemoryTransformTurnRunner extends TurnRunner {
  createMemoryTransformForTest(model: Model<any>) {
    return this.createMemoryTransform(model);
  }

  getMemorySnapshotForTest() {
    return this.memory.getSnapshot();
  }
}

describe("TurnRunner memory", () => {
  test("observational transform does not persist raw messages below observation threshold", async () => {
    const runner = new MemoryTransformTurnRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      memory: { enabled: true },
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
