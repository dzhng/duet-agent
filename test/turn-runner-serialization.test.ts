import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Context } from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import type { TurnState } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

class CapturingTurnRunner extends TurnRunner {
  constructor(config?: Partial<TurnRunnerConfig>) {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
      ...config,
    });
  }

  async captureLlmContext(input: AgentWorkerInput): Promise<string> {
    const agent = this.createAgent({
      state: input.state,
      ...this.createTools(input.state.mode),
    });
    const contexts: Context[] = [];
    agent.streamFn = (_model, context) => {
      contexts.push(JSON.parse(JSON.stringify(context)) as Context);
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

    await agent.prompt(input.prompt);

    const context = contexts[0];
    if (!context) throw new Error("Expected stream function to receive LLM context");
    return JSON.stringify(context);
  }

  captureToolExecution(input: AgentWorkerInput): string {
    const agent = this.createAgent({
      state: input.state,
      ...this.createTools(input.state.mode),
    });
    return agent.toolExecution;
  }

  captureRuntimeSettings(input: AgentWorkerInput): {
    modelProvider: string;
    modelId: string;
    thinkingLevel: string;
  } {
    const agent = this.createAgent({
      state: input.state,
      ...this.createTools(input.state.mode),
    });
    return {
      modelProvider: agent.state.model.provider,
      modelId: agent.state.model.id,
      thinkingLevel: agent.state.thinkingLevel,
    };
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

  test("loads AGENTS.md into the system prompt by default", async () => {
    const runner = new CapturingTurnRunner({ cwd: process.cwd() });

    const context = JSON.parse(
      await runner.captureLlmContext({
        state: createSerializableTurnState(),
        prompt: "Check default system prompt files.",
      }),
    ) as Context;

    expect(context.systemPrompt).toContain('<system_prompt_file path="AGENTS.md">');
    expect(context.systemPrompt).toContain("<content>");
    expect(context.systemPrompt).toContain("Treat Types As Documentation");
  });

  test("includes tool parallelism guidance in the default system prompt", async () => {
    const runner = new CapturingTurnRunner({ cwd: process.cwd(), systemPromptFiles: [] });

    const context = JSON.parse(
      await runner.captureLlmContext({
        state: createSerializableTurnState(),
        prompt: "Check default tool guidance.",
      }),
    ) as Context;

    expect(context.systemPrompt).toContain("<use_parallel_tool_calls>");
    expect(context.systemPrompt).toContain(
      "whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.",
    );
  });

  test("configures pi-agent tool calls for parallel execution", () => {
    const runner = new CapturingTurnRunner({ cwd: process.cwd(), systemPromptFiles: [] });

    const toolExecution = runner.captureToolExecution({
      state: createSerializableTurnState(),
      prompt: "Check tool execution mode.",
    });

    expect(toolExecution).toBe("parallel");
  });

  test("restores persisted model and thinking level", () => {
    const runner = new CapturingTurnRunner({
      model: "anthropic:claude-opus-4-7",
      thinkingLevel: "medium",
      systemPromptFiles: [],
    });
    const state: TurnState = {
      ...createSerializableTurnState(),
      options: {
        model: "anthropic:claude-sonnet-4-6",
        memoryModel: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "high",
      },
    };

    const settings = runner.captureRuntimeSettings({
      state: JSON.parse(JSON.stringify(state)) as TurnState,
      prompt: "Check restored runtime settings.",
    });

    expect(settings).toEqual({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "high",
    });
  });

  test("includes both configured base instructions and system prompt files", async () => {
    const runner = new CapturingTurnRunner({
      cwd: process.cwd(),
      systemInstructions: "Base instruction marker: prefer precise answers.",
    });

    const context = JSON.parse(
      await runner.captureLlmContext({
        state: createSerializableTurnState(),
        prompt: "Check combined system prompt layers.",
      }),
    ) as Context;

    expect(context.systemPrompt).toContain("Base instruction marker: prefer precise answers.");
    expect(context.systemPrompt).toContain('<system_prompt_file path="AGENTS.md">');
    expect(context.systemPrompt).toContain("Treat Types As Documentation");
  });

  test("overrides default system prompt files", async () => {
    const runner = new CapturingTurnRunner({
      cwd: process.cwd(),
      systemPromptFiles: ["README.md"],
    });

    const context = JSON.parse(
      await runner.captureLlmContext({
        state: createSerializableTurnState(),
        prompt: "Check configured system prompt files.",
      }),
    ) as Context;

    expect(context.systemPrompt).toContain('<system_prompt_file path="README.md">');
    expect(context.systemPrompt).toContain("# duet-agent");
    expect(context.systemPrompt).not.toContain('<system_prompt_file path="AGENTS.md">');
  });

  test("can disable system prompt file loading", async () => {
    const runner = new CapturingTurnRunner({ cwd: process.cwd(), systemPromptFiles: [] });

    const context = JSON.parse(
      await runner.captureLlmContext({
        state: createSerializableTurnState(),
        prompt: "Check disabled system prompt files.",
      }),
    ) as Context;

    expect(context.systemPrompt).not.toContain("<system_prompt_file");
    expect(context.systemPrompt).not.toContain("Treat Types As Documentation");
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
        createAssistantMessage({
          text: "I will inspect the deployment.",
          timestamp: 2,
          extraContent: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "read_file",
              arguments: { path: "package.json" },
            },
          ],
        }),
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read_file",
          content: [{ type: "text", text: '{"name":"duet-agent"}' }],
          details: { path: "package.json", bytes: 21 },
          isError: false,
          timestamp: 3,
        },
        createAssistantMessage({ text: "The deployment config is serializable.", timestamp: 2 }),
      ],
    },
  };
}
