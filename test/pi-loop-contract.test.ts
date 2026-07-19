import { describe, expect, test } from "bun:test";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createTaskManager } from "../src/tasks/task-manager.js";
import { wrapBackgroundable } from "../src/turn-runner/task-tools.js";
import { waitFor } from "./helpers/async.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";
import { createAssistantMessage } from "./helpers/messages.js";

const noParameters = Type.Object({});
const commandParameters = Type.Object({ command: Type.String() });

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function terminatingToolCall(name: string, id = `${name}-call`) {
  return createAssistantMessage({
    extraContent: [{ type: "toolCall", id, name, arguments: {} }],
  });
}

function createScriptedAgent(
  responses: ReturnType<typeof createAssistantMessage>[],
  tools: AgentTool[],
) {
  const modelCalls: Message[][] = [];
  const streamFn: StreamFn = (...streamArguments) => {
    const context = streamArguments[1];
    modelCalls.push(structuredClone(context.messages));
    const response = responses[modelCalls.length - 1];
    if (!response) throw new Error(`Unexpected model call ${modelCalls.length}`);
    const reason = response.stopReason;
    if (reason !== "stop" && reason !== "toolUse" && reason !== "length") {
      throw new Error(`Unsupported scripted stop reason: ${reason}`);
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason, message: response });
    });
    return stream;
  };
  const agent = new Agent({
    initialState: {
      model: { provider: "unknown", id: "pi-loop-contract" } as never,
      tools,
    },
    streamFn,
    toolExecution: "parallel",
  });
  return { agent, modelCalls };
}

function terminatingResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    terminate: true,
  };
}

describe("pi agent loop contract", () => {
  test("a steer queued during a terminating tool batch revives the inner loop", async () => {
    let agent!: Agent;
    const tool: AgentTool<typeof noParameters> = {
      name: "terminate_with_steer",
      label: "Terminate with steer",
      description: "Queues a steer while returning a terminating result.",
      parameters: noParameters,
      execute: async () => {
        agent.steer(userMessage("steer queued during tool execution"));
        return terminatingResult("terminated");
      },
    };
    const scripted = createScriptedAgent(
      [terminatingToolCall(tool.name), createAssistantMessage({ text: "revived" })],
      [tool],
    );
    agent = scripted.agent;

    await agent.prompt("start");

    expect(scripted.modelCalls).toHaveLength(2);
    expect(scripted.modelCalls[1]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "steer queued during tool execution" }],
      }),
    );
  });

  test("a follow-up queued during a terminating tool batch revives the outer loop", async () => {
    let agent!: Agent;
    const tool: AgentTool<typeof noParameters> = {
      name: "terminate_with_follow_up",
      label: "Terminate with follow-up",
      description: "Queues a follow-up while returning a terminating result.",
      parameters: noParameters,
      execute: async () => {
        agent.followUp(userMessage("follow-up queued during tool execution"));
        return terminatingResult("terminated");
      },
    };
    const scripted = createScriptedAgent(
      [terminatingToolCall(tool.name), createAssistantMessage({ text: "revived" })],
      [tool],
    );
    agent = scripted.agent;

    await agent.prompt("start");

    expect(scripted.modelCalls).toHaveLength(2);
    expect(scripted.modelCalls[1]).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "follow-up queued during tool execution" }],
      }),
    );
  });

  test("empty queues make a terminating tool batch terminal", async () => {
    const tool: AgentTool<typeof noParameters> = {
      name: "terminate",
      label: "Terminate",
      description: "Returns a terminating result.",
      parameters: noParameters,
      execute: async () => terminatingResult("terminated"),
    };
    const scripted = createScriptedAgent([terminatingToolCall(tool.name)], [tool]);
    scripted.agent.steer(userMessage("stale steer"));
    scripted.agent.followUp(userMessage("stale follow-up"));
    expect(scripted.agent.hasQueuedMessages()).toBe(true);

    scripted.agent.clearAllQueues();
    expect(scripted.agent.hasQueuedMessages()).toBe(false);

    await scripted.agent.prompt("start");

    expect(scripted.modelCalls).toHaveLength(1);
    expect(scripted.agent.hasQueuedMessages()).toBe(false);
  });

  test("one sequential tool serializes preparation and execution for the whole batch", async () => {
    const order: string[] = [];
    const createTool = (
      name: string,
      executionMode?: AgentTool<typeof noParameters>["executionMode"],
    ): AgentTool<typeof noParameters> => ({
      name,
      label: name,
      description: `Records execution of ${name}.`,
      parameters: noParameters,
      ...(executionMode ? { executionMode } : {}),
      execute: async () => {
        order.push(`execute:${name}`);
        return terminatingResult(name);
      },
    });
    const tools = [
      createTool("ordinary_before"),
      createTool("sequential", "sequential"),
      createTool("ordinary_after"),
    ];
    const scripted = createScriptedAgent(
      [
        createAssistantMessage({
          extraContent: tools.map((tool) => ({
            type: "toolCall" as const,
            id: `${tool.name}-call`,
            name: tool.name,
            arguments: {},
          })),
        }),
      ],
      tools,
    );
    scripted.agent.beforeToolCall = async ({ toolCall }) => {
      order.push(`prepare:${toolCall.name}`);
      return undefined;
    };

    await scripted.agent.prompt("start");

    expect(order).toEqual([
      "prepare:ordinary_before",
      "execute:ordinary_before",
      "prepare:sequential",
      "execute:sequential",
      "prepare:ordinary_after",
      "execute:ordinary_after",
    ]);
    expect(scripted.modelCalls).toHaveLength(1);
  });

  test("task-backed foreground shell calls execute in model order", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const starts: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const baseTool: AgentTool<typeof commandParameters> = {
      name: "bash",
      label: "bash",
      description: "Run a shell command.",
      parameters: commandParameters,
      async execute(_id, params) {
        const command = String(params.command);
        starts.push(command);
        await (command === "first" ? firstGate : secondGate);
        return terminatingResult(command);
      },
    };
    const bash = wrapBackgroundable(baseTool, {
      taskManager: manager,
      defaultWaitBudgetMs: 120_000,
      clock,
      ownerScopeId: () => "turn-1",
      label: (params) => String(params.command),
    });
    const scripted = createScriptedAgent(
      [
        createAssistantMessage({
          extraContent: [
            { type: "toolCall", id: "bash-first", name: "bash", arguments: { command: "first" } },
            {
              type: "toolCall",
              id: "bash-second",
              name: "bash",
              arguments: { command: "second" },
            },
          ],
        }),
      ],
      [bash],
    );
    const running = scripted.agent.prompt("start");

    try {
      await waitFor(() => starts.length > 0);
      expect(starts).toEqual(["first"]);
      releaseFirst();
      await waitFor(() => starts.length === 2);
      expect(starts).toEqual(["first", "second"]);
      releaseSecond();
      await running;
    } finally {
      releaseFirst();
      releaseSecond();
      await running;
    }
  });

  test("an early tool result detaches later work from updates and the ended agent run", async () => {
    let releaseInnerWork!: () => void;
    const continueInnerWork = new Promise<void>((resolve) => {
      releaseInnerWork = resolve;
    });
    let detachedWork!: Promise<string>;
    const tool: AgentTool<typeof noParameters> = {
      name: "still_running",
      label: "Still running",
      description: "Returns before its detached inner work finishes.",
      parameters: noParameters,
      execute: async (...executeArguments) => {
        const onUpdate = executeArguments[3];
        detachedWork = (async () => {
          await continueInnerWork;
          onUpdate?.({
            content: [{ type: "text", text: "late update one" }],
            details: {},
          });
          await Promise.resolve();
          onUpdate?.({
            content: [{ type: "text", text: "late update two" }],
            details: {},
          });
          return "inner work finished";
        })();
        return terminatingResult("still running");
      },
    };
    const scripted = createScriptedAgent([terminatingToolCall(tool.name)], [tool]);
    const eventTypes: AgentEvent["type"][] = [];
    scripted.agent.subscribe((event) => {
      eventTypes.push(event.type);
    });
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", captureUnhandledRejection);

    try {
      await scripted.agent.prompt("start");
      expect(eventTypes.at(-1)).toBe("agent_end");
      expect(eventTypes).not.toContain("tool_execution_update");

      releaseInnerWork();
      await expect(detachedWork).resolves.toBe("inner work finished");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(eventTypes).not.toContain("tool_execution_update");
      expect(unhandledRejections).toEqual([]);

      const agentEventSink = scripted.agent as unknown as {
        processEvents(event: AgentEvent): Promise<void>;
      };
      await expect(
        agentEventSink.processEvents({ type: "agent_end", messages: [] }),
      ).rejects.toThrow("Agent listener invoked outside active run");
    } finally {
      process.off("unhandledRejection", captureUnhandledRejection);
    }
  });
});
