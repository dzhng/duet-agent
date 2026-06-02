import { describe, expect } from "bun:test";
import dedent from "dedent";
import { allAssistantText } from "../src/core/serializer.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Every state-machine terminal — whether the parent selected it or a
 * state failed at runtime — fires one final parent turn so the parent
 * can summarize the outcome and, when appropriate, kick off follow-up
 * work via another `create_state_machine_definition` call.
 *
 * These evals exist because the acknowledgment turn is a real product
 * blindspot: without it the parent's transcript jumps straight from
 * "tool called" to the next user message, and the parent then acts as if
 * the prior state machine were still running. The two cases below prove
 * the parent both receives the terminal signal and is able to take
 * action on it:
 *
 * - decided terminal: parent reaches a happy-path terminal it chose and
 *   then chains a follow-up state machine as instructed.
 * - runtime_failure terminal: a sub-agent state errors unexpectedly and
 *   the parent's final reply explicitly references the failure instead
 *   of claiming work is still running.
 *
 * Both runs keep their work deliberately cheap — the only real state
 * either state machine runs is a tiny agent state that finishes in one
 * shot — so the eval focuses on routing/acknowledgment, not throughput.
 */
describe("state-machine terminal acknowledgment", () => {
  testIfDocker(
    "parent takes a follow-up action after a decided terminal",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        // Keep the eval focused on the acknowledgment behavior. The
        // parent wires SM1, lets it reach a terminal, and on SM1's
        // acknowledgment turn creates SM2 — proving the parent both
        // received the SM1 terminal and could act on it. SM2 starts
        // with a terminal `firstState`, so SM2 immediately terminates
        // too; the parent then gets SM2's acknowledgment turn and
        // emits the final FOLLOWUP_REGISTERED token. The final assert
        // on `terminal.result` therefore exercises the full chain:
        // SM1 ack → create SM2 → SM2 ack → reply. This is the answer
        // to "does a state machine created during ack get its own
        // ack?" — yes, because each SM lives on its own session.
        systemInstructions: dedent`
          You are in an eval. Do not read, edit, or run anything outside
          the state-machine tools. Follow this script exactly:

          1. Create a state machine named "primary_followup_demo" with
             two states: an agent state named "noop" whose prompt is
             "reply with the single word: ok", and a terminal state
             named "primary_done" with status "completed". Use
             firstState "noop" so the runner starts noop immediately
             after the create call. After "noop" completes, select
             "primary_done" via select_state_machine_state — selecting
             a terminal state by name is how you end the machine.
          2. The runner will then wake you with the terminal details for
             "primary_done". On that SM1 acknowledgment turn, create a
             second state machine named "followup_after_terminal" whose
             definition has at least one agent state and a terminal
             state named "followup_done" with status "completed". Use
             firstState "followup_done" so no real work runs. Do NOT
             reply with any text on this SM1 ack turn — the only
             action is the create_state_machine_definition call.
          3. SM2 will go terminal immediately (firstState was the
             terminal). The runner will then wake you a second time
             with the SM2 terminal details. On that SM2 acknowledgment
             turn, reply to the user with EXACTLY this text and nothing
             else: FOLLOWUP_REGISTERED
          4. Do not call select_state_machine_state on either
             acknowledgment turn.
          5. Make exactly one create_state_machine_definition call per
             state machine — do not retry or amend the definition.
        `,
      });

      const toolCalls: Array<{ name: string; input: any }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.status !== "running") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: "Run the primary_followup_demo script.",
      });
      const terminal = await turn;

      // Only count well-formed creates so a flaky retry where the model
      // re-issues a malformed `states: "[...stringified]"` payload does
      // not double-count. The test cares about each SM being created
      // exactly once with a valid definition, not about the model's
      // recovery attempts inside a single create.
      const creates = toolCalls.filter(
        (call) =>
          call.name === "create_state_machine_definition" &&
          Array.isArray(call.input?.definition?.states),
      );
      expect(creates.length).toBe(2);
      expect(creates[0]?.input?.definition?.name).toBe("primary_followup_demo");
      expect(creates[1]?.input?.definition?.name).toBe("followup_after_terminal");

      // Because SM1 uses firstState="noop", the runner runs noop
      // automatically; the only required select call is the terminal
      // selection for primary_done. The acknowledgment turn must not
      // call select_state_machine_state at all (the SM is already
      // terminal), so the total count is exactly one terminal-selecting
      // call.
      const selectCalls = toolCalls.filter((call) => call.name === "select_state_machine_state");
      expect(selectCalls.length).toBe(1);
      // The lone select must terminate SM1 by naming the terminal state
      // directly — there is no separate kind verb to disambiguate, the
      // dispatch is driven entirely by the state's own kind in the
      // definition (`primary_done` is the terminal here).
      const selectDecision = selectCalls[0]?.input?.decision;
      expect(selectDecision?.state).toBe("primary_done");

      expect(terminal.type).toBe("complete");
      if (terminal.type === "complete") {
        // The token may land on the SM1 ack (right after creating SM2)
        // or on the SM2 ack (after firstState=followup_done auto-runs).
        // We accept either, since both prove the full chain
        // SM1 ack → create SM2 → SM2 ack ran end-to-end.
        expect(allAssistantText(terminal.state.agent?.messages ?? [])).toContain(
          "FOLLOWUP_REGISTERED",
        );
      }
    },
    180_000,
  );

  testIfDocker(
    "parent acknowledges a runtime_failure terminal in plain text",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are in an eval. Do not read, edit, or run anything outside
          the state-machine tools. Follow this script exactly:

          1. Create a state machine named "runtime_failure_demo" with
             two states: a script state named "always_fails" whose
             command is "exit 7" (so it fails at runtime), and a
             terminal state named "done" with status "completed" — the
             tool requires every definition to declare a completed
             terminal even when the happy path is not reachable. The
             runner auto-injects "failed" / "cancelled" terminals on
             top, which is what "always_fails" will route to. Use
             firstState "always_fails".
          2. The runner will wake you with the terminal details for the
             failed state. On that acknowledgment turn, reply to the
             user in plain text. Your reply must contain the exact
             token RUNTIME_FAILURE_ACK and must also include the failing
             state name "always_fails" so the user can see you noticed
             which state failed. Do not call any state-machine tool on
             this acknowledgment turn.
          3. Make exactly one create_state_machine_definition call — do
             not retry or amend the definition.
        `,
      });

      const toolCalls: Array<{ name: string; input: any }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.status !== "running") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: "Run the runtime_failure_demo script.",
      });
      const terminal = await turn;

      const creates = toolCalls.filter(
        (call) =>
          call.name === "create_state_machine_definition" &&
          Array.isArray(call.input?.definition?.states),
      );
      expect(creates.length).toBe(1);

      // Acknowledgment turn must not call any state-machine tool — the
      // SM is already terminal and a fresh create is not what the
      // script asked for. The list of tool calls after the initial
      // create must be empty.
      const toolsAfterCreate = toolCalls.slice(1);
      expect(toolsAfterCreate.filter((c) => c.name === "select_state_machine_state")).toEqual([]);
      expect(toolsAfterCreate.filter((c) => c.name === "create_state_machine_definition")).toEqual(
        [],
      );

      expect(terminal.type).toBe("complete");
      if (terminal.type === "complete") {
        // For a runtime-error terminal the public `terminal.result` is
        // not set — the runner surfaces `error` plus the controller's
        // terminal status and leaves `result` undefined. The parent's
        // acknowledgment reply lives in the parent transcript instead.
        const assistantTexts = allAssistantText(terminal.state.agent?.messages ?? []);
        expect(assistantTexts).toContain("RUNTIME_FAILURE_ACK");
        expect(assistantTexts).toContain("always_fails");
        // The state-machine session itself ended as a runtime `error` (the
        // script state exited non-zero); the parent's acknowledgment reply
        // did not change that. Runtime failures use `error`, distinct from a
        // deliberately selected `failed` terminal.
        expect(terminal.state.stateMachine?.terminal?.status).toBe("error");
        expect(terminal.state.stateMachine?.terminalAcknowledged).toBe(true);
      }
    },
    180_000,
  );
});
