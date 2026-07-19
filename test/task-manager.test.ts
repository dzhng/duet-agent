import { describe, expect, test } from "bun:test";
import { createTaskManager, type TaskManager } from "../src/tasks/task-manager.js";
import type { TaskDescriptor, TaskEvent } from "../src/tasks/types.js";
import { createFakeTaskWork, type FakeTaskWork } from "./helpers/fake-task-work.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

function startWork(
  manager: TaskManager,
  work: FakeTaskWork<string>,
  ownerScopeId = "root",
  parentScopeId?: string,
) {
  return manager.start({
    kind: "tool",
    name: `work-${ownerScopeId}`,
    label: `Work in ${ownerScopeId}`,
    ownerScopeId,
    ...(parentScopeId === undefined ? {} : { parentScopeId }),
    execute: (context) => work.run(context),
  });
}

async function started(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("TaskManager", () => {
  test("reports the next monotonic id across starts and recovery", () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    expect(manager.nextTaskId()).toBe(1);
    manager.start({
      kind: "scheduled",
      name: "later",
      label: "Later",
      ownerScopeId: "root",
      wakeAt: 10,
    });
    expect(manager.nextTaskId()).toBe(2);

    const recovered = createTaskManager({ clock: new ManualRuntimeClock() });
    recovered.recover([], 9);
    expect(recovered.nextTaskId()).toBe(9);
  });

  test("keeps a foreground task running when its budget elapses", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const work = createFakeTaskWork();
    const handle = startWork(manager, work);
    await started();

    const race = manager.raceForeground(handle, 120_000);
    await clock.advanceBy(120_000);

    expect(await race).toEqual({
      kind: "still_running",
      task: {
        descriptor: expect.objectContaining({ id: "t1", status: "running" }),
        output: [],
      },
    });
    expect(work.abortSignal?.aborted).toBe(false);

    work.resolve("finished later");
    await started();
    expect(manager.nextSettled()).toEqual({
      id: "t1",
      status: "completed",
      settledAt: 120_000,
      result: "finished later",
    });
  });

  test("gives an exact-deadline completion the budget photo finish", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const work = createFakeTaskWork();
    const handle = startWork(manager, work);
    await started();
    clock.schedule(() => work.resolve("on the line"), 10);
    const race = manager.raceForeground(handle, 10);
    await clock.advanceBy(10);

    expect(await race).toEqual({
      kind: "settled",
      settlement: { id: "t1", status: "completed", settledAt: 10, result: "on the line" },
    });
  });

  test("retains ordered output values and settles exactly once", async () => {
    const clock = new ManualRuntimeClock(50);
    const events: TaskEvent[] = [];
    const manager = createTaskManager({ clock, onEvent: (event) => events.push(event) });
    const work = createFakeTaskWork();
    const handle = startWork(manager, work);
    await started();
    work.emitOutput("first");
    work.emitOutput("second");
    work.resolve("done");
    await started();

    expect(manager.output(handle.id)).toEqual({
      descriptor: expect.objectContaining({ id: "t1", status: "completed" }),
      output: ["first", "second"],
      settlement: { id: "t1", status: "completed", settledAt: 50, result: "done" },
    });
    await manager.stop(handle.id, "too late");
    expect(events.filter((event) => event.type === "settled")).toEqual([
      {
        type: "settled",
        settlement: { id: "t1", status: "completed", settledAt: 50, result: "done" },
      },
    ]);
  });

  test("pulls settlements FIFO by settlement time rather than task id", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const first = createFakeTaskWork();
    const second = createFakeTaskWork();
    startWork(manager, first);
    startWork(manager, second);
    await started();

    second.resolve("second task first");
    await started();
    first.resolve("first task second");
    await started();

    expect(manager.nextSettled()).toEqual(expect.objectContaining({ id: "t2" }));
    expect(manager.nextSettled()).toEqual(expect.objectContaining({ id: "t1" }));
    expect(manager.nextSettled()).toBeUndefined();
  });

  test("does not lose a settlement between nextSettled calls", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const work = createFakeTaskWork();
    startWork(manager, work);
    await started();
    expect(manager.nextSettled()).toBeUndefined();

    work.resolve("arrived between pulls");
    await started();
    expect(manager.nextSettled()).toEqual(
      expect.objectContaining({ id: "t1", result: "arrived between pulls" }),
    );
  });

  test("stop after budget conversion aborts once and waits for executor cleanup", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const work = createFakeTaskWork();
    const handle = startWork(manager, work);
    await started();
    const race = manager.raceForeground(handle, 5);
    await clock.advanceBy(5);
    expect((await race).kind).toBe("still_running");

    let stopResolved = false;
    const stop = manager.stop(handle.id, "user requested").then((value) => {
      stopResolved = true;
      return value;
    });
    const duplicateStop = manager.stop(handle.id, "second stop");
    await started();
    expect(work.abortSignal?.aborted).toBe(true);
    expect(work.abortReason).toBe("user requested");
    expect(stopResolved).toBe(false);

    work.completeCleanup();
    expect(await stop).toEqual({
      descriptor: expect.objectContaining({ id: "t1", status: "stopped" }),
      output: [],
      settlement: { id: "t1", status: "stopped", settledAt: 5, reason: "user requested" },
    });
    expect(await duplicateStop).toEqual(
      expect.objectContaining({
        settlement: expect.objectContaining({ reason: "user requested" }),
      }),
    );
    expect(manager.nextSettled()).toEqual(
      expect.objectContaining({ id: "t1", reason: "user requested" }),
    );
    expect(manager.nextSettled()).toBeUndefined();
  });

  test("scope close unwinds descendants before their owners and waits for every cleanup", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const root = createFakeTaskWork();
    const child = createFakeTaskWork();
    const grandchild = createFakeTaskWork();
    startWork(manager, root, "root");
    startWork(manager, child, "child", "root");
    startWork(manager, grandchild, "grandchild", "child");
    await started();

    let closed = false;
    const close = manager.closeScope("root", "scope done").then(() => {
      closed = true;
    });
    await started();
    expect(grandchild.abortSignal?.aborted).toBe(true);
    expect(child.abortSignal?.aborted).toBe(false);
    expect(root.abortSignal?.aborted).toBe(false);

    grandchild.completeCleanup();
    await started();
    await started();
    expect(child.abortSignal?.aborted).toBe(true);
    expect(root.abortSignal?.aborted).toBe(false);
    child.completeCleanup();
    await started();
    await started();
    expect(root.abortSignal?.aborted).toBe(true);
    expect(closed).toBe(false);
    root.completeCleanup();
    await close;
    expect(closed).toBe(true);
    expect(manager.pendingWork()).toEqual({ kind: "complete" });
  });

  test("accepts scope depth two and centrally rejects depth three", () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const scheduled = (ownerScopeId: string, parentScopeId?: string) =>
      manager.start({
        kind: "scheduled",
        name: ownerScopeId,
        label: ownerScopeId,
        ownerScopeId,
        ...(parentScopeId === undefined ? {} : { parentScopeId }),
        wakeAt: 100,
      });

    expect(scheduled("root").id).toBe("t1");
    expect(scheduled("child", "root").id).toBe("t2");
    expect(scheduled("grandchild", "child").id).toBe("t3");
    expect(() => scheduled("too-deep", "grandchild")).toThrow(
      "Task scope depth 3 exceeds maximum 2",
    );
    expect(manager.list().map(({ id }) => id)).toEqual(["t1", "t2", "t3"]);
  });

  test("interruptAll aborts all work, runs reapers, and drains finished barriers", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const first = createFakeTaskWork();
    const second = createFakeTaskWork();
    startWork(manager, first);
    startWork(manager, second);
    manager.start({
      kind: "scheduled",
      name: "wake",
      label: "Wake later",
      ownerScopeId: "root",
      wakeAt: 500,
    });
    const reaped: string[] = [];
    manager.registerReaper((reason) => {
      reaped.push(reason);
    });
    await started();

    let interrupted = false;
    const interrupt = manager.interruptAll("interrupt").then(() => {
      interrupted = true;
    });
    await started();
    expect(reaped).toEqual(["interrupt"]);
    expect(first.abortSignal?.aborted).toBe(true);
    expect(second.abortSignal?.aborted).toBe(true);
    expect(interrupted).toBe(false);

    first.completeCleanup();
    second.completeCleanup();
    await interrupt;
    expect(interrupted).toBe(true);
    expect(manager.list().map(({ status }) => status)).toEqual(["stopped", "stopped", "stopped"]);
    expect(manager.pendingWork()).toEqual({ kind: "complete" });
  });

  test("recover marks in-process work lost, preserves schedules, and advances ids", () => {
    const clock = new ManualRuntimeClock(1_000);
    const manager = createTaskManager({ clock });
    const recovered: TaskDescriptor[] = [
      {
        id: "t4",
        kind: "subagent",
        name: "orphan",
        label: "Orphaned process",
        ownerScopeId: "root",
        status: "running",
        startedAt: 100,
      },
      {
        id: "t8",
        kind: "scheduled",
        name: "wake",
        label: "Wake later",
        ownerScopeId: "root",
        status: "scheduled",
        startedAt: 200,
        wakeAt: 2_000,
      },
    ];

    expect(manager.recover(recovered).lost).toEqual([
      expect.objectContaining({ id: "t4", status: "lost" }),
    ]);
    expect(manager.nextSettled()).toEqual({ id: "t4", status: "lost", settledAt: 1_000 });
    expect(manager.pendingWork()).toEqual({ kind: "sleep", wakeAt: 2_000 });
    expect(
      manager.start({
        kind: "scheduled",
        name: "next",
        label: "Next task",
        ownerScopeId: "root",
        wakeAt: 3_000,
      }).id,
    ).toBe("t9");
  });

  test("recover restores bounded output for lost-task reporting", () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock(1_000) });
    manager.recover(
      [
        {
          id: "t4",
          kind: "subagent",
          name: "orphan",
          label: "Orphaned process",
          ownerScopeId: "root",
          status: "running",
          startedAt: 100,
        },
      ],
      8,
      { t4: ["one", "two"] },
    );

    expect(manager.output("t4")).toMatchObject({
      descriptor: { status: "lost" },
      output: ["one", "two"],
      settlement: { status: "lost" },
    });
    expect(manager.nextTaskId()).toBe(8);
  });

  test("waitForSettlement observes values without consuming the pull FIFO", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const work = createFakeTaskWork();
    const handle = startWork(manager, work);
    await started();
    const wait = manager.waitForSettlement(handle.id, 20);
    work.resolve("observable");
    await started();

    expect(await wait).toEqual(
      expect.objectContaining({ settlement: expect.objectContaining({ result: "observable" }) }),
    );
    expect(manager.nextSettled()).toEqual(expect.objectContaining({ result: "observable" }));

    const timeout = manager.waitForSettlement(undefined, 20);
    await clock.advanceBy(20);
    expect(await timeout).toBeUndefined();
  });

  test("a targeted settlement wait survives unrelated task completion", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const first = createFakeTaskWork();
    const second = createFakeTaskWork();
    startWork(manager, first);
    const secondHandle = startWork(manager, second);
    await started();
    const waitForSecond = manager.waitForSettlement(secondHandle.id);

    first.resolve("unrelated");
    await started();
    second.resolve("target");
    await started();

    expect(await waitForSecond).toEqual(
      expect.objectContaining({
        settlement: expect.objectContaining({ id: "t2", result: "target" }),
      }),
    );
    expect(manager.nextSettled()).toEqual(expect.objectContaining({ id: "t1" }));
    expect(manager.nextSettled()).toEqual(expect.objectContaining({ id: "t2" }));
  });

  test("observes executor rejection immediately and exposes it as a failed settlement", async () => {
    const manager = createTaskManager({ clock: new ManualRuntimeClock() });
    const work = createFakeTaskWork();
    startWork(manager, work);
    await started();
    const failure = new Error("boom");
    work.reject(failure);
    await started();

    expect(manager.nextSettled()).toEqual(
      expect.objectContaining({ id: "t1", status: "failed", error: failure }),
    );
  });
});
