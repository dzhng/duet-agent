import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * End-to-end coverage for the built-in `/relay` skill. Unlike the legacy
 * TUI-side rewrite, the token now stays in the prompt verbatim and the
 * turn runner injects the relay skill body via `SkillContext` as a
 * `<skill name="relay">...</skill>` block. This eval drops a raw `/relay`
 * prompt straight into a fresh `TurnRunner` and asserts the resulting
 * inference flips routing toward `create_state_machine_definition`,
 * even on a task shape that would otherwise route to `todo_write`
 * (cf. `state-machine-routing.eval.ts`).
 *
 * The delta — small task baseline picks todos; `/relay` flips to a
 * state machine — is the contract the built-in skill promises users.
 */
describe("/relay routing", () => {
  testIfDocker(
    "inline /relay flips a small task from todo_write to a state machine",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        // `includeDefaults: false` skips user/project skill discovery; the
        // built-in `/relay` skill is still merged in by
        // `loadDiscoveredSkills` so the slash token resolves.
        skillDiscovery: { includeDefaults: false },
        // Mirror the routing eval's planning-only harness so we measure
        // the routing decision, not the execution.
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
        if (step.type !== "tool_call_start") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      // The prompt is intentionally a small, in-conversation task — the
      // exact shape that routes to todo_write in the baseline. The
      // `/relay` token is what should flip the decision.
      const prompt = dedent`
        /relay plan three small things: rename foo to bar in src/util.ts,
        then add a one-line comment above its declaration explaining the
        rename, then tell me you are done.
      `;

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt,
      });
      const terminal = await turn;

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );
      const todoCalls = toolCalls.filter((call) => call.name === "todo_write");

      // Primary assertion: the built-in skill body injected by the runner
      // was strong enough to override the default "small task → todos"
      // routing.
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
