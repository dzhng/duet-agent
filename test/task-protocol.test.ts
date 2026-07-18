import { describe, expect, test } from "bun:test";
import type {
  TaskDescriptor,
  TaskSnapshot,
  TurnDuringEvent,
  TurnState,
} from "../src/types/protocol.js";

describe("task protocol", () => {
  test("round-trips ordered lifecycle events and the durable task snapshot", () => {
    const runningTask: TaskDescriptor = {
      id: "t7",
      kind: "subagent",
      name: "research",
      label: "Research deployment failures",
      ownerScopeId: "root",
      status: "running",
      startedAt: 1_000,
    };
    const scheduledTask: TaskDescriptor = {
      id: "t8",
      kind: "scheduled",
      name: "poll",
      label: "Poll deployment status",
      ownerScopeId: "task:t7",
      status: "scheduled",
      startedAt: 1_100,
      wakeAt: 9_000,
    };
    const events: TurnDuringEvent[] = [
      {
        type: "task_started",
        task: runningTask,
        origin: { kind: "task", taskId: "t7", ownerScopeId: "root" },
      },
      {
        type: "task_output",
        taskId: "t7",
        chunk: "first delta\n",
        origin: { kind: "task", taskId: "t7", ownerScopeId: "root" },
      },
      {
        type: "task_settled",
        settlement: { id: "t7", status: "completed", settledAt: 2_000, result: "done" },
        origin: { kind: "task", taskId: "t7", ownerScopeId: "root" },
      },
    ];
    const outputSnapshot: TaskSnapshot = {
      descriptor: runningTask,
      output: ["first delta\n", "second delta\n"],
    };
    const state: TurnState = {
      status: "running",
      mode: "agent",
      agent: { status: "running", messages: [] },
      tasks: [runningTask, scheduledTask],
      nextTaskId: 9,
    };

    const resumed = JSON.parse(JSON.stringify({ events, outputSnapshot, state })) as {
      events: TurnDuringEvent[];
      outputSnapshot: TaskSnapshot;
      state: TurnState;
    };

    expect(resumed.events.map(({ type }) => type)).toEqual([
      "task_started",
      "task_output",
      "task_settled",
    ]);
    expect(resumed.events[1]).toEqual(
      expect.objectContaining({
        taskId: "t7",
        chunk: "first delta\n",
        origin: { kind: "task", taskId: "t7", ownerScopeId: "root" },
      }),
    );
    expect(resumed.outputSnapshot.output).toEqual(["first delta\n", "second delta\n"]);
    expect(resumed.state.tasks).toEqual([runningTask, scheduledTask]);
    expect(resumed.state.tasks?.[1]).toEqual(expect.objectContaining({ wakeAt: 9_000 }));
    expect(resumed.state.nextTaskId).toBe(9);
  });
});
