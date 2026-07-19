import { describe, expect, test } from "bun:test";
import type { TaskDescriptor, TaskStatus } from "../src/tasks/types.js";
import { projectTaskTree, type TaskTreeProjectionInput } from "../src/tui/task-tree.js";
import type { TurnTokenUsage } from "../src/types/protocol.js";

const NOW = new Date("2026-07-19T14:31:00.000Z").getTime();

function task(
  id: `t${number}`,
  status: TaskStatus,
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    id,
    kind: "tool",
    name: "bash",
    label: "npm test",
    ownerScopeId: "turn-1",
    status,
    startedAt: NOW - 252_000,
    ...overrides,
  };
}

function usage(totalTokens: number): TurnTokenUsage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("task tree projection", () => {
  test("renders the accepted nesting, status glyphs, elapsed values, and held-awake line", () => {
    const tasks = [
      task("t3", "completed"),
      task("t4", "running", {
        kind: "subagent",
        name: "spawn_agent",
        label: "audit auth flows for missing rate limits",
        startedAt: NOW - 363_000,
      }),
      task("t7", "running", {
        label: "rg -n rate_limit",
        ownerScopeId: "task:t4",
        startedAt: NOW - 8_000,
      }),
      task("t5", "scheduled", {
        kind: "scheduled",
        name: "poll",
        label: "deploy-status",
        wakeAt: new Date("2026-07-19T14:32:00.000Z").getTime(),
      }),
    ];
    const events = [
      {
        type: "task_settled",
        settlement: { id: "t3", status: "completed", settledAt: NOW, result: "ok" },
      },
      { type: "usage", ...usageFields(2000) },
      {
        type: "usage",
        ...usageFields(14_400),
        origin: { taskId: "t4" },
      },
      { type: "step", step: { type: "text", text: "reviewing audit results…" } },
    ] satisfies NonNullable<TaskTreeProjectionInput["events"]>;

    const projection = projectTaskTree({ tasks, events, now: NOW });
    const text = projection.rows.map((row) => row.text).join("\n");

    expect(text).toContain("● parent — reviewing audit results…");
    expect(text).toContain("├─ ✔ t3 bash `npm test` 4m12s");
    expect(text).toContain(
      "├─ ⠙ t4 spawn_agent audit auth flows for missing rate limits 6m03s   [12.4k tok]",
    );
    expect(text).toContain("│  └─ ⠙ t7 bash `rg -n rate_limit` 8s");
    expect(text).toContain("└─ ◷ t5 poll deploy-status — wakes");
    expect(text).toContain("turn open: held awake by t4, t7");
    expect(projection.heldAwakeBy).toEqual(["t4", "t7"]);
  });

  test("assigns a deliberate glyph to every durable task status", () => {
    const statuses: TaskStatus[] = [
      "running",
      "scheduled",
      "completed",
      "failed",
      "stopped",
      "lost",
    ];
    const text = projectTaskTree({
      tasks: statuses.map((status, index) => task(`t${index + 1}`, status)),
      now: NOW,
    })
      .rows.map((row) => row.text)
      .join("\n");
    for (const glyph of ["⠙", "◷", "✔", "✘", "■", "?"]) expect(text).toContain(glyph);
  });

  test("late-attach snapshot reconstructs lanes without a terminal or replayed events", () => {
    const projection = projectTaskTree({
      tasks: [task("t4", "running"), task("t7", "running", { ownerScopeId: "task:t4" })],
      now: NOW,
      initialTurnTokens: 9000,
    });
    expect(projection.rows.map((row) => row.taskId).filter(Boolean)).toEqual(["t4", "t7"]);
    expect(projection.heldAwakeBy).toEqual(["t4", "t7"]);
  });

  test("task-origin usage receives only its cumulative delta", () => {
    const projection = projectTaskTree({
      tasks: [task("t4", "running")],
      now: NOW,
      initialTurnTokens: 10_000,
      events: [
        { type: "usage", ...usageFields(11_000) },
        {
          type: "usage",
          ...usageFields(13_500),
          origin: { taskId: "t4" },
        },
      ],
    });
    expect(projection.rows.find((row) => row.taskId === "t4")?.tokenUsage).toBe(2500);
  });
});

function usageFields(totalTokens: number) {
  const value = usage(totalTokens);
  return {
    turnUsage: value,
    usageByModel: [],
    lastMessageUsage: value,
    effectiveContextWindow: 200_000,
    contextWindowUsage: {
      systemPrompt: totalTokens,
      messages: 0,
      localMemory: 0,
      globalMemory: 0,
    },
  };
}
