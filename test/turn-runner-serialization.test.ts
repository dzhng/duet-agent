import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import type { TurnState } from "../src/types/protocol.js";

class CapturingTurnRunner extends TurnRunner {
  constructor(config?: Partial<TurnRunnerConfig>) {
    super({
      model: "anthropic:claude-opus-4-6",
      skillDiscovery: { includeDefaults: false },
      ...config,
    });
  }

  async captureLlmContext(input: Omit<AgentWorkerInput, "tools">): Promise<string> {
    const agent = this.createAgent({
      ...input,
      ...this.createTools(input.state.mode, input.state),
    });
    const contexts: Context[] = [];
    agent.streamFn = (_model, context) => {
      contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
      });
      return stream;
    };

    await agent.prompt(input.prompt);

    const context = contexts[0];
    if (!context) throw new Error("Expected stream function to receive LLM context");
    return JSON.stringify(context);
  }
}

describe("TurnState serialization", () => {
  test("reconstructs the exact same LLM context after JSON round trip", async () => {
    const runner = new CapturingTurnRunner({
      systemInstructions: "Keep the system prompt stable for prompt caching.",
    });
    const state = createSerializableTurnState();
    const resumedState = JSON.parse(JSON.stringify(state)) as TurnState;
    const originalNow = Date.now;
    Date.now = () => 1_717_171_717;

    try {
      const originalContext = await runner.captureLlmContext({
        state,
        prompt: "Continue with the cached context.",
      });
      const resumedContext = await runner.captureLlmContext({
        state: resumedState,
        prompt: "Continue with the cached context.",
      });

      expect(resumedContext).toBe(originalContext);
    } finally {
      Date.now = originalNow;
    }
  });
});

function createSerializableTurnState(): TurnState {
  return {
    status: "completed",
    mode: "agent",
    agent: {
      status: "completed",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Inspect the deployment." }],
          timestamp: 1,
        },
        createAssistantMessage("I will inspect the deployment.", [
          {
            type: "toolCall",
            id: "tool-1",
            name: "read_file",
            arguments: { path: "package.json" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read_file",
          content: [{ type: "text", text: '{"name":"duet-agent"}' }],
          details: { path: "package.json", bytes: 21 },
          isError: false,
          timestamp: 3,
        },
        createAssistantMessage("The deployment config is serializable."),
      ],
    },
  };
}

function createAssistantMessage(
  text: string,
  extraContent: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...extraContent],
    api: "unknown",
    provider: "unknown",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}
