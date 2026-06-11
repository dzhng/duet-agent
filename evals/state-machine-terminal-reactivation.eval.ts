import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Covers two halves of the terminal-lifecycle contract end-to-end on a real
 * TurnRunner:
 *
 * 1. Selecting a terminal stops the auto-drive loop and hands control back to
 *    the user. After the model selects `done`, the machine must not advance to
 *    another state on its own — the turn ends with the terminal recorded and no
 *    `state_started` after the `state_machine_completed` event.
 *
 * 2. A finished machine can be reactivated, but ONLY when the user explicitly
 *    asks. On a follow-up user turn that says the result was wrong and to redo
 *    the work, the model selects the non-terminal work state again. The new
 *    reactivation path must clear the prior `terminal` and record a
 *    `state_machine_reactivated` event carrying the prior outcome.
 *
 * The reactivation assertions are the "only-if" check: a cleared `terminal`
 * plus a `state_machine_reactivated` event whose priorTerminal is the original
 * `done` outcome can only hold if `runDecision` cleared the terminal when a
 * non-terminal state was selected on a terminal session. If that code is
 * removed, the terminal persists and these assertions fail.
 */
describe("state machine terminal reactivation", () => {
  testIfDocker(
    "terminal ends the turn, and an explicit user request reactivates the finished machine",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "sm-reactivate-"));
      try {
        const definition: StateMachineDefinition = {
          name: "reactivation_eval",
          prompt: "Produce a code, then finish. May be asked to redo.",
          states: [
            {
              kind: "agent",
              name: "make_code",
              prompt: dedent`
                Reply with exactly the word BANANA and nothing else.
                Do not call any tools.
              `,
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Code produced.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: workDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "On the first user prompt, select make_code (no input), then after it completes select the done terminal.",
            "If a later user prompt says the result was wrong and asks you to redo or run the work again, reactivate the finished machine by selecting make_code again.",
          ].join("\n"),
        });

        await runner.start({ type: "start", mode: definition });

        // Turn 1: run the work state, then select the terminal.
        const turn1 = await runner.turn({
          type: "prompt",
          message: "Start the eval: make the code, then finish.",
          behavior: "follow_up",
        });

        expectCompleted(turn1);
        expect(turn1.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        // Auto-drive stopped at the terminal: nothing started after the
        // machine completed, so selecting the terminal was the last move.
        expect(startedAfterCompletion(turn1.state)).toEqual([]);

        // Turn 2: explicit user request to redo the work on the finished
        // machine. This is the only path that may reactivate it.
        const turn2 = await runner.turn({
          type: "prompt",
          message: "That's wrong — BANANA is not what I wanted. Run the make_code step again.",
          behavior: "follow_up",
        });

        expectCompleted(turn2);
        // A reactivation event was recorded. `recordStateMachineReactivated`
        // only emits this event when it actually clears a set `terminal`, so
        // its presence proves the prior terminal was cleared when the model
        // selected a non-terminal state on the finished machine. (The model
        // then re-runs make_code and may select `done` again, re-terminating
        // by the end of the turn — that is correct.)
        const reactivated = lastReactivation(turn2.state);
        expect(reactivated).toBeDefined();
        expect(reactivated!.state).toBe("make_code");
        expect(reactivated!.priorTerminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        // The work state actually re-ran live after reactivation.
        expect(startedAfter(turn2.state, "state_machine_reactivated")).toContain("make_code");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function history(state: TurnState): StateMachineSessionEvent[] {
  return state.stateMachine?.history ?? [];
}

/** State names started after the most recent `state_machine_completed` event. */
function startedAfterCompletion(state: TurnState): string[] {
  return startedAfter(state, "state_machine_completed");
}

/** State names started after the most recent event of the given type. */
function startedAfter(state: TurnState, afterType: StateMachineSessionEvent["type"]): string[] {
  const events = history(state);
  let index = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === afterType) {
      index = i;
      break;
    }
  }
  if (index === -1) return [];
  const started: string[] = [];
  for (let i = index + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === "state_started") started.push(event.state);
  }
  return started;
}

function lastReactivation(
  state: TurnState,
): Extract<StateMachineSessionEvent, { type: "state_machine_reactivated" }> | undefined {
  const events = history(state);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "state_machine_reactivated") return event;
  }
  return undefined;
}
