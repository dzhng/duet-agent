import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { Session } from "../src/session/session.js";
import type { AgentWorkerInput, AgentWorkerResult } from "../src/turn-runner/turn-runner.js";
import type { TurnCommand, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { waitFor } from "./helpers/async.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { ManualRuntimeClock } from "./helpers/manual-runtime-clock.js";
import { TestTurnRunner } from "./helpers/turn-runner-protocol.js";

class WakeRecordingRunner extends TestTurnRunner {
  wakeCommands = 0;

  override async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    if (command.type === "wake") this.wakeCommands += 1;
    return super.turn(command);
  }
}

describe("Session wake scheduling", () => {
  // TUI/library surface: Session is not on Duet's RPC path.
  testIfDocker("TUI/library surface keeps a sleeping wake armed during prompt()", async () => {
    const clock = new ManualRuntimeClock(2_000);
    const wakeAt = clock.now() + 100;
    const runner = new WakeRecordingRunner(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { clock, minimumScheduledDelayMs: 1 },
    );
    const releasePrompt = deferred<void>();
    let workerCalls = 0;
    runner.worker = async (input: AgentWorkerInput, next: () => Promise<AgentWorkerResult>) => {
      workerCalls += 1;
      if (workerCalls === 2) await releasePrompt.promise;
      runner.controlResults.push(
        input.prompt === "Set the Session reminder."
          ? { type: "select_state_machine_state", decision: { state: "reminder" } }
          : { type: "none" },
      );
      return next();
    };

    const sessionPath = await mkdtemp(join(tmpdir(), "duet-session-wake-"));
    const session = new Session(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      {
        id: "session_wake_survives_prompt",
        runner,
        sessionPath,
        resumeFromStorage: false,
        clock,
      },
    );

    let wakeCommandsAtDeadline = -1;
    try {
      await session.start({ mode: reminderDefinition(wakeAt) });
      await session.prompt({ message: "Set the Session reminder." });
      const sleeping = await session.waitForTerminal();
      expect(sleeping).toMatchObject({ type: "sleep", wakeAt });

      await session.prompt({ message: "Keep talking while the deadline arrives." });
      await waitFor(() => workerCalls === 2);
      await clock.advanceBy(100);
      wakeCommandsAtDeadline = runner.wakeCommands;
    } finally {
      releasePrompt.resolve();
      await session.waitForTerminal();
      await session.dispose();
      await rm(sessionPath, { recursive: true, force: true });
    }

    expect(wakeCommandsAtDeadline).toBe(1);
  });
});

function reminderDefinition(wakeAt: number): StateMachineDefinition {
  return {
    name: "session_one_time_reminder",
    prompt: "Deliver one reminder at its deadline.",
    states: [
      { kind: "timer", name: "reminder", wakeAt },
      {
        kind: "agent",
        name: "tell_user",
        prompt: "Tell the user their Session reminder now.",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
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
