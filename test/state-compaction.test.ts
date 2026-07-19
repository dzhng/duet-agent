import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnState } from "../src/types/protocol.js";
import { compactTurnState, DEFAULT_STATE_MAX_BYTES } from "../src/turn-runner/state-compaction.js";
import { createTaskManager } from "../src/tasks/task-manager.js";
import { createTaskAdminTools } from "../src/turn-runner/task-tools.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "calling tool" },
      { type: "toolCall", toolCallId: id, name: "bash", arguments: {} },
    ],
    stopReason: "end_turn",
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, output: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text: output }],
    isError: false,
  } as unknown as AgentMessage;
}

function state(messages: AgentMessage[], extra: Partial<TurnState> = {}): TurnState {
  return {
    status: "running",
    mode: "auto",
    ...extra,
    agent: {
      status: "running",
      messages,
    },
  } as TurnState;
}

describe("compactTurnState", () => {
  test("no-op when state already fits", () => {
    const messages: AgentMessage[] = [userMessage("hi"), userMessage("there")];
    const before = state(messages);
    const result = compactTurnState(before);

    expect(result.evicted).toBe(0);
    expect(result.state).toBe(before);
    expect(result.bytes).toBe(JSON.stringify(before).length);
  });

  test("evicts oldest messages until state fits the cap", () => {
    const big = "x".repeat(2000);
    const messages: AgentMessage[] = [
      userMessage(`m0 ${big}`),
      userMessage(`m1 ${big}`),
      userMessage(`m2 ${big}`),
      userMessage(`m3 ${big}`),
    ];
    const before = state(messages);

    const result = compactTurnState(before, { maxBytes: 5 * 1024 });

    expect(result.bytes).toBeLessThanOrEqual(5 * 1024);
    expect(result.evicted).toBeGreaterThanOrEqual(2);
    const kept = result.state.agent.messages as AgentMessage[];
    expect((kept.at(-1) as { content: { text: string }[] }).content[0].text).toContain("m3");
    const keptTexts = kept.map((m) => (m as { content: { text: string }[] }).content[0].text);
    expect(keptTexts.some((t) => t.startsWith("m0"))).toBe(false);
  });

  test("drops a leading orphan tool-result after eviction", () => {
    const huge = "y".repeat(8000);
    const messages: AgentMessage[] = [
      {
        ...assistantToolCall("call_1"),
        content: [
          { type: "text", text: huge },
          { type: "toolCall", toolCallId: "call_1", name: "bash", arguments: {} },
        ],
      } as AgentMessage,
      toolResult("call_1", "ok"),
      userMessage("follow-up"),
    ];
    const before = state(messages);

    const result = compactTurnState(before, { maxBytes: 4 * 1024 });

    const kept = result.state.agent.messages as AgentMessage[];
    expect(kept.length).toBe(1);
    expect((kept[0] as { role: string }).role).toBe("user");
    expect(result.evicted).toBe(2);
  });

  test("drops a leading assistant so the head is always user", () => {
    const huge = "a".repeat(8000);
    const messages: AgentMessage[] = [
      userMessage(`stale ${huge}`),
      assistantToolCall("call_1"),
      toolResult("call_1", "ok"),
      userMessage("recent"),
    ];
    const before = state(messages);

    const result = compactTurnState(before, { maxBytes: 4 * 1024 });

    const kept = result.state.agent.messages as AgentMessage[];
    expect(kept.length).toBe(1);
    expect((kept[0] as { role: string }).role).toBe("user");
    expect((kept[0] as { content: { text: string }[] }).content[0].text).toBe("recent");
    expect(result.evicted).toBe(3);
  });

  test("never evicts below MIN_RETAINED_MESSAGES, even if still oversize", () => {
    const giant = "z".repeat(10_000);
    const before = state([userMessage(giant)]);
    const result = compactTurnState(before, { maxBytes: 1024 });

    expect(result.evicted).toBe(0);
    expect(result.state.agent.messages.length).toBe(1);
    expect(result.bytes).toBeGreaterThan(1024);
  });

  test("does not mutate the input state", () => {
    const big = "q".repeat(3000);
    const messages: AgentMessage[] = [
      userMessage(`a ${big}`),
      userMessage(`b ${big}`),
      userMessage(`c ${big}`),
    ];
    const before = state(messages);
    const before_serialized = JSON.stringify(before);

    compactTurnState(before, { maxBytes: 4 * 1024 });

    expect(JSON.stringify(before)).toBe(before_serialized);
    expect(before.agent.messages.length).toBe(3);
  });

  test("preserves non-message TurnState fields after trimming", () => {
    const big = "p".repeat(2500);
    const messages: AgentMessage[] = [
      userMessage(`first ${big}`),
      userMessage(`second ${big}`),
      userMessage(`third ${big}`),
    ];
    const before = state(messages, {
      todos: [{ id: "t1", content: "ship", status: "in_progress" }],
      followUpQueue: [{ message: "later" }],
      queuedCommands: [],
      options: { model: "anthropic:claude-opus-4-7" },
    } as Partial<TurnState>);

    const result = compactTurnState(before, { maxBytes: 4 * 1024 });

    expect(result.evicted).toBeGreaterThan(0);
    expect(result.state.todos).toEqual(before.todos);
    expect(result.state.followUpQueue).toEqual(before.followUpQueue);
    expect(result.state.options).toEqual(before.options);
    expect(result.state.mode).toBe("auto");
    expect(result.state.agent.status).toBe("running");
  });

  test("no-op when there are no agent messages to evict", () => {
    const before = state([]);
    const result = compactTurnState(before, { maxBytes: 16 });

    expect(result.evicted).toBe(0);
    expect(result.state).toBe(before);
  });

  test("default cap is 100 MB", () => {
    expect(DEFAULT_STATE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  test("keeps paired tool-call/tool-result intact across eviction boundary", () => {
    const stale = "s".repeat(4000);
    const messages: AgentMessage[] = [
      userMessage(`drop me ${stale}`),
      userMessage("new turn"),
      assistantToolCall("call_keep"),
      toolResult("call_keep", "result kept"),
      userMessage("after tool"),
    ];
    const before = state(messages);

    const result = compactTurnState(before, { maxBytes: 3 * 1024 });

    const kept = result.state.agent.messages as AgentMessage[];
    const hasCall = kept.some((m) => {
      const content = (m as { content?: unknown[] }).content ?? [];
      return content.some(
        (b) =>
          (b as { type?: string }).type === "toolCall" &&
          (b as { toolCallId?: string }).toolCallId === "call_keep",
      );
    });
    const hasResult = kept.some((m) => (m as { toolCallId?: string }).toolCallId === "call_keep");
    // Either both survive together or both are evicted together. Half-pairs
    // are what wedges providers on resume.
    expect(hasCall).toBe(hasResult);
  });

  test("pins the tool-call/result pair that carries a live task handle", () => {
    const stale = "s".repeat(4000);
    const messages: AgentMessage[] = [
      userMessage(`old turn ${stale}`),
      userMessage("launch background work"),
      assistantToolCall("call_live"),
      toolResult("call_live", "Task t7 is still running; inspect it with task_output."),
      userMessage("newest turn"),
    ];
    const before = state(messages, {
      tasks: [
        {
          id: "t7",
          kind: "tool",
          name: "bash",
          label: "Run the test suite",
          ownerScopeId: "turn-1",
          status: "running",
          startedAt: 1_000,
        },
      ],
      nextTaskId: 8,
    });

    const result = compactTurnState(before, { maxBytes: 300 });
    const kept = result.state.agent.messages as AgentMessage[];
    const recoveredTaskIds = kept
      .filter((message) => (message as { role?: string }).role === "toolResult")
      .flatMap((message) => JSON.stringify(message).match(/\bt\d+\b/g) ?? []);
    const hasCall = kept.some((message) =>
      ((message as { content?: unknown[] }).content ?? []).some(
        (block) =>
          (block as { type?: string }).type === "toolCall" &&
          (block as { toolCallId?: string }).toolCallId === "call_live",
      ),
    );

    expect(recoveredTaskIds).toContain("t7");
    expect(hasCall).toBe(true);
    expect(result.state.tasks).toEqual(before.tasks);
    expect(result.state.nextTaskId).toBe(8);
  });

  test("task_output reads retained buffers even when the launch transcript is evicted", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const handle = manager.start({
      kind: "tool",
      name: "bash",
      label: "long task",
      ownerScopeId: "turn-1",
      execute: async ({ onOutput }) => {
        onOutput("BUFFER_SENTINEL_8Q2");
        return "done";
      },
    });
    await manager.waitForSettlement(handle.id);
    const launch = state(
      [
        userMessage(`old launch ${"x".repeat(8_000)}`),
        assistantToolCall("call_evicted"),
        toolResult("call_evicted", "Task t1 is still running"),
        userMessage("new context"),
      ],
      { tasks: [...manager.list()], nextTaskId: manager.nextTaskId() },
    );
    const compacted = compactTurnState(launch, { maxBytes: 500 }).state;
    expect(JSON.stringify(compacted.agent.messages)).not.toContain("call_evicted");

    const output = createTaskAdminTools({ taskManager: manager, clock }).find(
      (tool) => tool.name === "task_output",
    );
    if (!output) throw new Error("task_output missing");
    const result = await output.execute("output-after-eviction", { id: "t1" });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("BUFFER_SENTINEL_8Q2"),
    });
  });
});
