import { describe, expect, test } from "bun:test";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import type { StateAgentResult } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

/**
 * Reproduces a bug where steering an active state-machine agent state spawns
 * a replacement state whose sub-agent starts running before the previous
 * sub-agent has actually torn down. Users observe events (reasoning, tool
 * calls) from the orphaned old state continuing to land in the TUI after
 * the parent turn already finished.
 *
 * Invariant under test: when `runDecision` replaces an active agent state,
 * the new state's `StateAgentHandle` must not be constructed until the
 * previous handle has had `interrupt()` called AND its `prompt()` promise
 * has resolved. That guarantees the controller — and any subscribers
 * downstream of the old handle — see a clean handoff instead of two
 * concurrent sub-agents.
 */
describe("state-machine replacement", () => {
  test("awaits the previous state's prompt resolution before creating the replacement handle", async () => {
    const definition: StateMachineDefinition = {
      name: "replacement",
      prompt: "Run.",
      states: [{ kind: "agent", name: "research", prompt: "Research." }],
    };

    let tick = 0;
    let calls = 0;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let resolveFirstPrompt: ((result: StateAgentResult) => void) | undefined;
    const firstPrompt = new Promise<StateAgentResult>((resolve) => {
      resolveFirstPrompt = resolve;
    });

    let firstInterruptedAt: number | undefined;
    let firstPromptResolvedAt: number | undefined;
    let secondCreatedAt: number | undefined;
    let firstInterruptedReason: string | undefined;

    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: () => {
        calls += 1;
        if (calls === 1) {
          firstStarted?.();
          return {
            prompt: async () => {
              const result = await firstPrompt;
              firstPromptResolvedAt = ++tick;
              return result;
            },
            interrupt: (reason) => {
              firstInterruptedAt = ++tick;
              firstInterruptedReason = reason;
              resolveFirstPrompt?.({ type: "interrupted" });
            },
            partialAssistantText: () => undefined,
            interruptedReason: () => firstInterruptedReason,
          };
        }
        secondCreatedAt = ++tick;
        return {
          prompt: async () => ({ type: "complete", result: "done" }),
          interrupt: () => {},
          partialAssistantText: () => undefined,
          interruptedReason: () => undefined,
        };
      },
    });
    controller.startSession({
      prompt: "Run.",
      definition,
      currentState: "research",
    });

    const firstRun = controller.runDecision({ kind: "run_state", state: "research" });
    await firstStartedPromise;

    const secondRun = controller.runDecision({
      kind: "run_state",
      state: "research",
      input: { plan: "revised" },
    });

    await Promise.all([firstRun, secondRun]);

    expect(firstInterruptedAt).toBeDefined();
    expect(firstPromptResolvedAt).toBeDefined();
    expect(secondCreatedAt).toBeDefined();

    // The old sub-agent must be fully torn down before the new one starts —
    // otherwise the orphaned agent keeps emitting events into the same turn.
    expect(secondCreatedAt!).toBeGreaterThan(firstInterruptedAt!);
    expect(secondCreatedAt!).toBeGreaterThan(firstPromptResolvedAt!);
  });

  // Repro of the orphan-mutation bug observed in real session state.json:
  // when a replacement fires, the old agent's prompt() rejects with
  // "Request was aborted" (because `agent.abort()` propagates as a thrown
  // error, not a clean `{ type: "interrupted" }`). Without an interrupt
  // guard on the failed/ask branches, the old run writes `state_failed`
  // and `state_machine_completed` into the session *after* the replacement
  // has already started and recorded `state_started`, leaving the session
  // permanently terminal with a stale failure reason.
  test("old run does not write state_failed or terminal after being replaced", async () => {
    const definition: StateMachineDefinition = {
      name: "replacement",
      prompt: "Run.",
      states: [{ kind: "agent", name: "work", prompt: "Work." }],
    };

    let calls = 0;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let rejectFirstPrompt: ((error: Error) => void) | undefined;
    const firstPrompt = new Promise<StateAgentResult>((_resolve, reject) => {
      rejectFirstPrompt = reject;
    });

    let firstInterruptedReason: string | undefined;
    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: () => {
        calls += 1;
        if (calls === 1) {
          firstStarted?.();
          return {
            // Mirror production's handle: when `interrupt(reason)` is called,
            // the handle remembers the reason and `prompt()` resolves as
            // `{ type: "interrupted" }` regardless of what the underlying
            // abort threw. This is the contract Option A relies on — the
            // controller no longer reads a side-channel flag.
            prompt: async () => {
              try {
                return await firstPrompt;
              } catch (error) {
                if (firstInterruptedReason !== undefined) return { type: "interrupted" };
                const message = error instanceof Error ? error.message : String(error);
                return { type: "failed", error: message };
              }
            },
            interrupt: (reason) => {
              firstInterruptedReason = reason;
              rejectFirstPrompt?.(new Error("Request was aborted."));
            },
            partialAssistantText: () => undefined,
            interruptedReason: () => firstInterruptedReason,
          };
        }
        return {
          prompt: async () => ({ type: "complete", result: "replacement done" }),
          interrupt: () => {},
          partialAssistantText: () => undefined,
          interruptedReason: () => undefined,
        };
      },
    });
    controller.startSession({ prompt: "Run.", definition, currentState: "work" });

    const firstRun = controller.runDecision({ kind: "run_state", state: "work" });
    await firstStartedPromise;

    const secondRun = controller.runDecision({
      kind: "run_state",
      state: "work",
      input: { plan: "revised" },
    });
    await Promise.all([firstRun, secondRun]);

    const session = controller.getSession();
    const historyTypes = session?.history.map((entry) => entry.type) ?? [];

    // The orphaned old run must not write a terminal failure event,
    // and must not mark the state machine as completed.
    expect(historyTypes).not.toContain("state_failed");
    expect(historyTypes).not.toContain("state_machine_completed");
    expect(session?.terminal).toBeUndefined();

    // The replacement state finished cleanly and its completion should be
    // the most recent state-level history entry.
    expect(historyTypes.at(-1)).toBe("state_completed");
  });
});
