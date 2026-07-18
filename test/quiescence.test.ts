import { describe, expect, test } from "bun:test";
import { computePendingWork } from "../src/tasks/quiescence.js";
import type { TaskDescriptor, TaskStatus } from "../src/tasks/types.js";

function descriptor(id: `t${number}`, status: TaskStatus, wakeAt?: number): TaskDescriptor {
  return {
    id,
    kind: status === "scheduled" ? "scheduled" : "tool",
    name: id,
    label: id,
    ownerScopeId: "root",
    status,
    startedAt: 0,
    ...(wakeAt === undefined ? {} : { wakeAt }),
  };
}

describe("computePendingWork", () => {
  test("returns complete for no work and terminal-only histories", () => {
    expect(computePendingWork([])).toEqual({ kind: "complete" });
    expect(
      computePendingWork([
        descriptor("t1", "completed"),
        descriptor("t2", "failed"),
        descriptor("t3", "stopped"),
        descriptor("t4", "lost"),
      ]),
    ).toEqual({ kind: "complete" });
  });

  test("sleeps until the earliest scheduled task", () => {
    expect(
      computePendingWork([descriptor("t1", "scheduled", 900), descriptor("t2", "scheduled", 400)]),
    ).toEqual({ kind: "sleep", wakeAt: 400 });
  });

  test("running work keeps mixed task sets open", () => {
    expect(
      computePendingWork([
        descriptor("t1", "scheduled", 400),
        descriptor("t2", "completed"),
        descriptor("t3", "running"),
      ]),
    ).toEqual({ kind: "open" });
  });
});
