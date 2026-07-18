import { describe, expect, test } from "bun:test";
import { DEFAULT_TASK_WAIT_BUDGET_MS } from "../src/types/config.js";
import { SystemRuntimeClock } from "../src/turn-runner/runtime-clock.js";
import { MINIMUM_STATE_MACHINE_DELAY_MS } from "../src/turn-runner/tools.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";

class InspectableTurnRunner extends TurnRunner {
  productionLifecycleDefaults(): {
    clock: unknown;
    taskWaitBudgetMs: number;
    minimumScheduledDelayMs: number;
  } {
    return {
      clock: this.clock,
      taskWaitBudgetMs: this.taskWaitBudgetMs,
      minimumScheduledDelayMs: this.minimumScheduledDelayMs,
    };
  }

  async createTimerDefinition(wakeAt: number): Promise<void> {
    const tool = this.createTools("auto").tools.find(
      (candidate) => candidate.name === "create_state_machine_definition",
    );
    if (!tool) throw new Error("create_state_machine_definition tool missing");
    await tool.execute("definition-1", {
      definition: {
        name: "clock seam",
        prompt: "Exercise the injected schedule clock.",
        states: [
          { kind: "timer", name: "wake", wakeAt },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
    });
  }
}

describe("ManualRuntimeClock", () => {
  test("advances a 120-second logical wait without wall-clock delay", async () => {
    const clock = new ManualRuntimeClock();
    let settled = false;
    const wait = clock.sleep(120_000).then(() => {
      settled = true;
    });

    await clock.advanceBy(119_999);
    expect(settled).toBe(false);

    await clock.advanceBy(1);
    expect(settled).toBe(true);
    await wait;
    expect(clock.now()).toBe(120_000);
  });

  test("fires callbacks by deadline and insertion order, flushing microtasks between them", async () => {
    const clock = new ManualRuntimeClock(1_000);
    const events: string[] = [];

    clock.schedule(() => events.push("later"), 20);
    clock.schedule(() => {
      events.push("first-at-deadline");
      queueMicrotask(() => events.push("microtask"));
    }, 10);
    clock.schedule(() => events.push("second-at-deadline"), 10);

    await clock.advanceBy(20);

    expect(events).toEqual(["first-at-deadline", "microtask", "second-at-deadline", "later"]);
    expect(clock.now()).toBe(1_020);
  });
});

describe("task lifecycle production defaults", () => {
  test("keeps the two-minute task budget and 15-minute schedule floor without injection", () => {
    const runner = new InspectableTurnRunner({ skillDiscovery: { includeDefaults: false } });

    expect(DEFAULT_TASK_WAIT_BUDGET_MS).toBe(120_000);
    expect(MINIMUM_STATE_MACHINE_DELAY_MS).toBe(15 * 60 * 1_000);
    expect(runner.productionLifecycleDefaults()).toEqual({
      clock: expect.any(SystemRuntimeClock),
      taskWaitBudgetMs: 120_000,
      minimumScheduledDelayMs: 15 * 60 * 1_000,
    });
  });

  test("runner schedule validation consumes the injected clock and floor", async () => {
    const clock = new ManualRuntimeClock(50_000);
    const runner = new InspectableTurnRunner(
      { skillDiscovery: { includeDefaults: false } },
      { clock, minimumScheduledDelayMs: 1_000 },
    );

    await expect(runner.createTimerDefinition(50_999)).rejects.toThrow(
      "wakeAt must be at least 1000 ms in the future",
    );
    await expect(runner.createTimerDefinition(51_000)).resolves.toBeUndefined();
  });
});
