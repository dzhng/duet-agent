import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { applyRelayCommand } from "../src/tui/relay-command.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * End-to-end coverage for the `/relay` inline slash command. The TUI submit
 * path runs `applyRelayCommand` before handing the prompt to the session
 * (see `src/tui/app.ts` → `dispatchTurn`). This eval replays the same
 * transform and asserts the resulting prompt actually steers the model
 * toward `create_state_machine_definition` instead of `todo_write` — even
 * on a request that would otherwise look like a small in-conversation
 * task and route to todos (cf. `state-machine-routing.eval.ts`).
 *
 * Without `/relay`, the matching "small task" eval expects `todo_write`.
 * With `/relay`, the same shape of task must flip to a state machine — that
 * delta is the contract the slash command promises the user.
 */
describe("/relay routing", () => {
  testIfDocker(
    "inline /relay flips a small task from todo_write to a state machine",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        // Mirror the routing eval's planning-only harness so we measure the
        // routing decision, not the execution.
        systemInstructions: dedent`
          You are in a planning-only eval. Do not read, edit, or run anything.
          Use exactly one planning tool to register a plan that matches the
          user's request. If you create a state machine, define a terminal
          state named "eval_done" with status "completed" and pass firstState
          "eval_done" so no real work runs. After the planning tool call,
          respond with exactly: PLAN_REGISTERED
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

      // The raw prompt is intentionally a small, in-conversation task — the
      // exact shape that routes to todo_write in the baseline eval. The
      // `/relay` token is what should flip the decision.
      const raw = dedent`
        /relay plan three small things: rename foo to bar in src/util.ts,
        then add a one-line comment above its declaration explaining the
        rename, then tell me you are done.
      `;

      const relay = applyRelayCommand(raw);
      // Sanity-check the transform itself before we spend tokens on it.
      expect(relay.applied).toBe(true);
      expect(relay.message).not.toContain("/relay");
      expect(relay.message).toContain("<system-reminder>");

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: relay.message,
      });
      const terminal = await turn;

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );
      const todoCalls = toolCalls.filter((call) => call.name === "todo_write");

      // Primary assertion: the reminder injected by `/relay` was strong
      // enough to override the default "small task → todos" routing.
      expect(stateMachineCalls.length).toBeGreaterThanOrEqual(1);
      expect(todoCalls.length).toBe(0);

      const definition = stateMachineCalls[0]?.input?.definition;
      expect(definition).toBeTruthy();
      expect(Array.isArray(definition.states)).toBe(true);
      expect(definition.states.length).toBeGreaterThanOrEqual(1);

      expect(terminal.type).toBe("complete");
    },
    120_000,
  );
});
