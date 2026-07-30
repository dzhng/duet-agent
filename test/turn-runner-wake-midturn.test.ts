import { describe, expect, test } from "bun:test";
import type { AgentWorkerInput, AgentWorkerResult } from "../src/turn-runner/turn-runner.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { waitFor } from "./helpers/async.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";
import { TestTurnRunner } from "./helpers/turn-runner-protocol.js";

class WakeMidturnRunner extends TestTurnRunner {
  readonly childStarted = deferred<void>();
  readonly releaseChild = deferred<void>();

  pendingWorkKind() {
    return this.taskManager.pendingWork().kind;
  }

  async startControllableAgent(): Promise<void> {
    const spawn = this.createTools("agent").tools.find((tool) => tool.name === "spawn_agent");
    if (!spawn) throw new Error("spawn_agent missing");
    await spawn.execute("spawn-reminder-blocker", {
      prompt: "Keep the turn genuinely open until the test releases you.",
      run_in_background: true,
    });
  }

  protected override async createSpawnedSubagentRun(): Promise<SubagentRun> {
    return {
      prompt: async () => {
        this.childStarted.resolve();
        await this.releaseChild.promise;
        return { type: "complete", result: "background agent finished" };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

describe("TurnRunner mid-turn wake", () => {
  test("delivers a one-time reminder exactly once when its wake lands during open work", async () => {
    const clock = new ManualRuntimeClock(1_000);
    const runner = new WakeMidturnRunner(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { clock, minimumScheduledDelayMs: 1 },
    );
    const definition = reminderDefinition(clock.now() + 100);
    let workerCalls = 0;
    let reminderDeliveries = 0;
    runner.worker = async (input: AgentWorkerInput, next: () => Promise<AgentWorkerResult>) => {
      workerCalls += 1;
      if (workerCalls === 2) await runner.startControllableAgent();
      if (input.prompt === "Tell the user their one-time reminder now.") {
        reminderDeliveries += 1;
      }
      runner.controlResults.push(controlForPrompt(input.prompt));
      return next();
    };

    await runner.start({ type: "start", mode: definition });
    const sleeping = await runner.turn({
      type: "prompt",
      message: "Set the reminder.",
      behavior: "follow_up",
    });
    expect(sleeping).toMatchObject({ type: "sleep", wakeAt: 1_100 });

    const activeTurn = runner.turn({
      type: "prompt",
      message: "Do unrelated work while the reminder is pending.",
      behavior: "follow_up",
    });
    await runner.childStarted.promise;
    await waitFor(() => runner.pendingWorkKind() === "open");

    await clock.advanceBy(100);
    const wakeAccepted = deferred<void>();
    const wake = runner.turn({ type: "wake" }, wakeAccepted.resolve);
    await wakeAccepted.promise;
    runner.releaseChild.resolve();
    await Promise.all([activeTurn, wake]);

    expect(reminderDeliveries).toBe(1);
  });
});

function reminderDefinition(wakeAt: number): StateMachineDefinition {
  return {
    name: "one_time_reminder",
    prompt: "Deliver one reminder at its deadline.",
    states: [
      { kind: "timer", name: "reminder", wakeAt },
      {
        kind: "agent",
        name: "tell_user",
        prompt: "Tell the user their one-time reminder now.",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function controlForPrompt(prompt: string): TurnRunnerControlResult {
  if (prompt === "Set the reminder.") {
    return { type: "select_state_machine_state", decision: { state: "reminder" } };
  }
  if (prompt.includes('The state "reminder" finished')) {
    return { type: "select_state_machine_state", decision: { state: "tell_user" } };
  }
  if (prompt.includes('The state "tell_user" finished')) {
    return { type: "select_state_machine_state", decision: { state: "done" } };
  }
  return { type: "none" };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
