import { describe, expect, test } from "bun:test";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

/**
 * Invariant: once a state-machine state has been explicitly interrupted,
 * subsequent wake events must NOT resume work on their own. An interrupt
 * is a deliberate human/parent decision, and waking is meant for scheduled
 * (poll/timer) states only. The state machine must tolerate any number of
 * wake events and still stay quiet until the parent explicitly selects a
 * state via `runDecision`.
 *
 * Real-world driver: a recovery cron on the host (e.g. chat-app's
 * `sm-recovery`) may re-poke a session it believes is stuck. If the session
 * was deliberately interrupted while running an agent state, those pokes
 * must be no-ops — only a parent-agent re-selection should resume work.
 */
describe("state-machine wake after interrupt", () => {
  test("wake is a no-op after an agent state has been interrupted, and stays a no-op for repeated wakes", async () => {
    const definition: StateMachineDefinition = {
      name: "wake-after-interrupt",
      prompt: "Run.",
      states: [{ kind: "agent", name: "research", prompt: "Research." }],
    };

    let interruptedReason: string | undefined;
    let promptResolved: ((result: { type: "interrupted" }) => void) | undefined;
    const promptSettled = new Promise<{ type: "interrupted" }>((resolve) => {
      promptResolved = resolve;
    });
    let agentStarted: (() => void) | undefined;
    const agentStartedPromise = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });

    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: () => ({
        prompt: async () => {
          agentStarted?.();
          return promptSettled;
        },
        interrupt: (reason) => {
          interruptedReason = reason;
          promptResolved?.({ type: "interrupted" });
        },
        partialAssistantText: () => undefined,
        interruptedReason: () => interruptedReason,
      }),
    });

    controller.startSession({
      prompt: "Run.",
      definition,
      currentState: "research",
    });

    const run = controller.runDecision({ kind: "run_state", state: "research" });
    await agentStartedPromise;

    controller.interrupt("User pressed stop.");
    const result = await run;
    expect(result).toEqual({ type: "interrupted" });

    // Repeated wake events on an interrupted state machine must all return
    // undefined — the controller has no scheduled work to resume.
    for (let i = 0; i < 3; i += 1) {
      const wakeResult = await controller.wake();
      expect(wakeResult).toBeUndefined();
    }

    // The session must remain in the interrupted sentinel state; wake has
    // not silently re-armed the agent state or moved the cursor.
    const session = controller.getSession();
    expect(session?.currentState).toBe("interrupted");
    expect(session?.terminal).toBeUndefined();
    // Exactly one interrupt was actually delivered to the agent handle —
    // wake must not re-trigger interrupt bookkeeping either.
    expect(interruptedReason).toBe("User pressed stop.");
  });
});
