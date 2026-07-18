import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createTaskManager } from "../src/tasks/task-manager.js";
import {
  createTaskAdminTools,
  settlementNotice,
  startedInBackgroundNotice,
  stillRunningNotice,
  wrapBackgroundable,
} from "../src/turn-runner/task-tools.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

function deferredTool(): {
  tool: AgentTool;
  finish(text: string): void;
  signals: AbortSignal[];
} {
  let finish!: (text: string) => void;
  const result = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const signals: AbortSignal[] = [];
  return {
    signals,
    finish,
    tool: {
      name: "bash",
      label: "bash",
      description: "Run bash.",
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
      async execute(_id, _params, signal, onUpdate) {
        if (!signal) throw new Error("task signal missing");
        signals.push(signal);
        onUpdate?.({ content: [{ type: "text", text: "partial\n" }], details: undefined });
        const aborted = new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
        const text = await Promise.race([result, aborted]);
        if (signal.aborted) throw new Error("aborted");
        return { content: [{ type: "text", text }], details: undefined };
      },
    },
  };
}

describe("task-backed tools", () => {
  test("foreground budget converts without aborting the task", async () => {
    const clock = new ManualRuntimeClock(5_000);
    const manager = createTaskManager({ clock });
    const deferred = deferredTool();
    const wrapped = wrapBackgroundable(deferred.tool, {
      taskManager: manager,
      defaultWaitBudgetMs: 2_000,
      clock,
      ownerScopeId: () => "root",
      label: (params) => String(params.command),
    });

    const execution = wrapped.execute("call-1", { command: "slow command" });
    await Promise.resolve();
    await clock.advanceBy(2_000);
    const converted = await execution;

    expect(converted.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Task t1 is still running"),
    });
    expect(deferred.signals[0]?.aborted).toBe(false);
    expect(manager.output("t1")?.output).toEqual(["partial\n"]);

    deferred.finish("partial\ndone");
    await manager.waitForSettlement("t1");
    expect(manager.output("t1")?.settlement).toMatchObject({ status: "completed" });
  });

  test("run_in_background returns B2 immediately", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const deferred = deferredTool();
    const wrapped = wrapBackgroundable(deferred.tool, {
      taskManager: manager,
      defaultWaitBudgetMs: 120_000,
      clock,
      ownerScopeId: () => "root",
      label: (params) => String(params.command),
    });

    const result = await wrapped.execute("call-2", {
      command: "background command",
      run_in_background: true,
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Started background task t1"),
    });
    expect(manager.list()).toMatchObject([{ id: "t1", status: "running" }]);
    deferred.finish("done");
    await manager.waitForSettlement("t1");
  });

  test("admin tools inspect buffers and stop work without creating descriptors", async () => {
    const clock = new ManualRuntimeClock(10_000);
    const manager = createTaskManager({ clock });
    manager.start({
      kind: "tool",
      name: "bash",
      label: "buffered command",
      ownerScopeId: "root",
      execute: async ({ signal, onOutput }) => {
        onOutput("survives transcript eviction");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    });
    await Promise.resolve();
    const [output, stop] = createTaskAdminTools({ taskManager: manager, clock });
    if (!output || !stop) throw new Error("task admin tools missing");

    const before = manager.list().map((task) => task.id);
    const inspected = await output.execute("output-1", { id: "t1" });
    const stopped = await stop.execute("stop-1", { id: "t1" });

    expect(inspected.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("survives transcript eviction"),
    });
    expect(stopped.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Status: stopped"),
    });
    expect(manager.list().map((task) => task.id)).toEqual(before);
    expect(output.executionMode).toBe("sequential");
    expect(stop.executionMode).toBe("sequential");
  });

  test("registered reaper aborts and awaits background tool unwind", async () => {
    const clock = new ManualRuntimeClock();
    const manager = createTaskManager({ clock });
    const deferred = deferredTool();
    const wrapped = wrapBackgroundable(deferred.tool, {
      taskManager: manager,
      defaultWaitBudgetMs: 120_000,
      clock,
      ownerScopeId: () => "root",
      label: () => "orphan probe",
    });
    await wrapped.execute("reaper-1", { command: "orphan probe", run_in_background: true });
    await Promise.resolve();

    // Falsification: omitting registerReaper in wrapBackgroundable left the signal live and
    // this assertion red; restoring the registration makes reapAll a completed stop barrier.
    const reaped = manager.reapAll("shutdown");
    await Promise.resolve();
    expect(deferred.signals[0]?.aborted).toBe(true);
    await reaped;
    expect(manager.output("t1")?.settlement).toMatchObject({ status: "stopped" });
  });

  test("wording builders are the shared B1-B3 sources", () => {
    const snapshot = {
      descriptor: {
        id: "t3" as const,
        kind: "tool" as const,
        name: "bash",
        label: "npm test",
        ownerScopeId: "root",
        status: "completed" as const,
        startedAt: 0,
      },
      output: ["47 passing"],
      settlement: {
        id: "t3" as const,
        status: "completed" as const,
        settledAt: 120_000,
        result: "done",
      },
    };

    expect(
      stillRunningNotice({
        ...snapshot,
        settlement: undefined,
        descriptor: { ...snapshot.descriptor, status: "running" },
      }),
    ).toContain("It continues in the background");
    expect(startedInBackgroundNotice(snapshot)).toContain("You'll be nudged when it settles");
    expect(settlementNotice([snapshot])).toContain("1 task settled while you were working");
    const second = {
      ...snapshot,
      descriptor: { ...snapshot.descriptor, id: "t4" as const, label: "npm run lint" },
      settlement: { ...snapshot.settlement, id: "t4" as const, settledAt: 120_001 },
    };
    const batched = settlementNotice([snapshot, second]);
    expect(batched).toContain("2 tasks settled while you were working");
    expect(batched.indexOf("t3")).toBeLessThan(batched.indexOf("t4"));
    expect(batched.match(/<system-reminder>/g)).toHaveLength(1);
  });
});
