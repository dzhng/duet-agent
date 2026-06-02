import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Target behavior for `create_state_machine_definition` while a state machine
 * is still active: an EXPLICIT, opt-in RESET.
 *
 * The control tools all return `terminate: true`, so the parent gets exactly
 * one control call per worker turn — it cannot end the old machine AND create
 * the new one in the same turn. So creating a machine while one is active is
 * treated as "replace the active machine," but only when the agent explicitly
 * opts in with `replaceActive: true`. Without that flag the create tool throws
 * a clear error naming the active machine and its current state, so an agent
 * that did not even realize a machine was running cannot blindly clobber it.
 * When the agent sets `replaceActive: true`, the runner supersedes the active
 * session with a `cancelled` terminal and starts the new machine in the same
 * turn.
 *
 * This eval drives a real model that creates a machine, then deliberately
 * creates a SECOND machine while the first is still active — opting into the
 * reset — and asserts the second machine becomes the running session and
 * reaches its own terminal.
 *
 * Expected RED before the fix: there is no `replaceActive` flag, create-while-
 * active never replaces the running machine, so the final session is still
 * "active_machine" (or the turn ends on the raw "Cannot create" error) and
 * "second_machine" never reaches its terminal.
 */
describe("state-machine create-while-active explicit reset", () => {
  testIfDocker(
    "supersedes the active machine when the agent opts into replaceActive",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are in a live eval that deliberately exercises the
          create-while-active reset path. Do not read, edit, or run anything
          outside the state-machine tools. Follow this script EXACTLY,
          including the intentional create-while-active in step 2 — it is
          required for the test and must not be skipped.

          1. Create a state machine named "active_machine" with exactly two
             states: an agent state named "work" whose prompt is "reply with
             the single word: ok", and a terminal state named "done" with
             status "completed". Use firstState "work" so the runner runs
             "work" immediately after the create call.
          2. After "work" completes, the runner will wake you to choose the
             next state. On THIS turn, you have decided to ABANDON
             "active_machine" and run a different machine instead. Call
             create_state_machine_definition to create a machine named
             "second_machine" with one agent state named "noop" (prompt "reply
             with the single word: ok") and a terminal state named
             "second_done" with status "completed", using firstState "noop".
             Because a machine is still active, you MUST pass replaceActive:
             true to replace it — that is the intended behavior here.
          3. After "noop" completes on "second_machine", the runner will wake
             you to choose the next state. Select the terminal state
             "second_done" to finish cleanly.
          4. Do not make any other tool calls.
        `,
      });

      const toolCalls: Array<{ name: string; input: any }> = [];
      // Track every terminal each machine reaches. The supersede path ends
      // "active_machine" as `cancelled`; a model that instead works around the
      // reset (by selecting active_machine's own "done" terminal before
      // creating the second machine) would end it `completed`. Asserting
      // `cancelled` is what pins the replaceActive supersede path specifically.
      const machineTerminals = new Map<string, string>();
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "state_machine") {
          const sm = event.stateMachine;
          if (sm.terminal) machineTerminals.set(sm.definition.name, sm.terminal.status);
          return;
        }
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.status !== "running") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: "Run the create-while-active reset script.",
      });
      const terminal = await turn;

      // The reset must actually have been exercised: both creates must happen,
      // with the second one after the first, and the second must opt into the
      // replacement. Otherwise the eval could false-pass by never tripping the
      // create-while-active path.
      const activeCreateIndex = toolCalls.findIndex(
        (call) =>
          call.name === "create_state_machine_definition" &&
          call.input?.definition?.name === "active_machine",
      );
      const resetCreate = toolCalls.find(
        (call) =>
          call.name === "create_state_machine_definition" &&
          call.input?.definition?.name === "second_machine" &&
          call.input?.replaceActive === true,
      );
      expect(activeCreateIndex).toBeGreaterThanOrEqual(0);
      expect(resetCreate).toBeDefined();

      // The reset path supersedes the running machine, so "active_machine" must
      // resolve to `cancelled` — not `completed`, which is what a workaround
      // (selecting its own terminal first) would produce.
      expect(machineTerminals.get("active_machine")).toBe("cancelled");

      // The new machine becomes the running session and reaches its own
      // terminal — proving the create-while-active reset replaced the active
      // machine rather than being rejected or re-prompted.
      expect(terminal.type).toBe("complete");
      if (terminal.type === "complete") {
        expect(terminal.status).toBe("completed");
        expect(terminal.state.stateMachine?.definition?.name).toBe("second_machine");
        expect(terminal.state.stateMachine?.terminal?.state).toBe("second_done");
        expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
        // The reset must be silent recovery, not a surfaced protocol error:
        // the raw guard message must never leak onto the turn error.
        expect(terminal.error ?? "").not.toContain("a state machine is already active");
      }
    },
    180_000,
  );
});
