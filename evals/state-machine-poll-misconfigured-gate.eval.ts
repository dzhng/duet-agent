import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { MISCONFIGURED_POLL_GATE_THRESHOLD } from "../src/turn-runner/state-machine-session.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Live wiring for the misconfigured poll-gate safeguard.
 *
 * Reproduces the real Video Pipeline board incident: an "in review" poll
 * whose command was `echo waiting for user review` exits 0 on every tick, so
 * the runner reads each attempt as "condition met", hands control back to the
 * orchestrator, and the orchestrator re-selects the same poll — hot-looping
 * every ~10-20s instead of honoring the 12h intervalMs. The poll's interval
 * is never reached because a successful poll never sleeps.
 *
 * The unit test in test/state-machine-poll-misconfigured-gate.test.ts drives
 * the controller directly. This eval proves the safeguard holds when a real
 * model orchestrates the broken board through the full TurnRunner loop: the
 * runner fails the relay with the actionable human-wait message on the
 * threshold-th consecutive success, bounding the loop instead of spinning.
 *
 * Falsification: delete the `successStreak >= MISCONFIGURED_POLL_GATE_THRESHOLD`
 * guard in runPollState (state-machine-controller.ts). The relay then never
 * terminates — the model re-selects `await_review` indefinitely and the turn
 * hot-loops past the threshold until it times out, exactly the bug this commit
 * fixed. The bounded `state_started` count and the failed terminal both go red.
 */
describe("misconfigured poll-gate guard (live)", () => {
  testIfDocker(
    "fails a hot-looping echo poll instead of spinning past the threshold",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "sm-poll-gate-"));
      try {
        const definition: StateMachineDefinition = {
          name: "video_pipeline_review_gate",
          prompt: "Hold the item in review until a human approves it.",
          states: [
            {
              kind: "poll",
              name: "await_review",
              // The footgun: an unconditional success on every tick. The
              // command never reflects whether a human actually approved, so
              // it can only ever exit 0 and the 12h interval is never reached.
              intervalMs: "12h",
              command: "echo waiting for user review",
            },
            {
              kind: "terminal",
              name: "shipped",
              status: "completed",
              reason: "Item approved and shipped.",
            },
          ],
        };

        const systemInstructions = [
          "This is a live eval for the runner's misconfigured poll-gate safeguard.",
          "The board has one poll state named `await_review` and a terminal `shipped`.",
          "On the initial prompt, call select_state_machine_state with state `await_review`.",
          "Whenever `await_review` completes, immediately call select_state_machine_state",
          "with state `await_review` again. Do NOT modify the command, do NOT select any",
          "other state, and do NOT finalize the relay yourself. Keep re-selecting",
          "`await_review` every time it completes — the runner decides when to stop.",
        ].join("\n");

        const runner = new TurnRunner({
          model,
          cwd,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions,
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: "Start watching the in-review item for approval.",
        });
        const terminal = await started.turn;

        // The runner tripped the guard and failed the relay rather than
        // letting the orchestrator spin on the always-true gate. Tripping the
        // gate is a runtime failure, so the turn fails (status "failed") and
        // the machine records an `error` terminal against the poll state.
        expect(terminal.type).toBe("complete");
        expect(terminal.type === "complete" ? terminal.status : undefined).toBe("failed");
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "await_review",
          status: "error",
        });

        // The failure message must be the actionable human-wait guidance, not
        // a generic error — it points the model at the real fix.
        const reason = terminal.state.stateMachine?.terminal?.reason ?? "";
        expect(reason).toContain("no state change");
        expect(reason).toContain("agent state");

        const history = (terminal.state.stateMachine?.history ?? []) as StateMachineSessionEvent[];
        const pollStarts = history.filter(
          (event) => event.type === "state_started" && event.state === "await_review",
        ).length;
        // Bounded loop: the poll ran exactly the threshold number of times and
        // was stopped — not the ~100 iterations of the original hot-loop.
        expect(pollStarts).toBe(MISCONFIGURED_POLL_GATE_THRESHOLD);

        // The 12h interval was never honored because a successful poll never
        // sleeps — which is the whole reason the gate hot-loops.
        const sleeps = terminal.state.stateMachine?.progress?.states.await_review?.sleeps ?? 0;
        expect(sleeps).toBe(0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
