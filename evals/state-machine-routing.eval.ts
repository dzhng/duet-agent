import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTodo } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/**
 * The routing question: when given a planning task in mode "auto", does the
 * model reach for todo_write or create_state_machine_definition? The system
 * prompt and tool descriptions should push session-spanning, well-scoped,
 * many-item work into a state machine of agent states, and keep small
 * in-conversation work in todo_write.
 *
 * These evals deliberately do not add their own routing guidance in
 * systemInstructions — the only signal the model has is the default
 * state-machine prompt layer plus the tool descriptions, which is what we are
 * tuning here.
 */
describe("state machine vs todo routing", () => {
  testIfDocker(
    "multi-phase refactor with many self-contained units routes to a state machine",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        // Intentionally minimal: do not tell the model which planning tool to
        // pick. Just keep it from actually executing the refactor so the eval
        // stays cheap and focused on the routing decision.
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

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: dedent`
          I want to land the tui/app.ts refactor on branch refactor/tui-app-split.
          The work breaks down into:

          Phase 1: extract layout.ts (pure layout builder, no shared state).
          Phase 2: carve ten controller modules out of the 2750-line mutable
          closure in app.ts — one module per controller (input, keymap,
          viewport, status, search, palette, theme, focus, prompt, history).
          Phase 3: build roughly thirty real-TUI tests across five new test
          files — one file per surface (rendering, keymap, search, palette,
          status).

          That is a multi-hour effort with deep wiring risk on every step and
          you should expect it to span sessions. Register the plan so the work
          survives the session boundary and each unit lands in its own clean
          diff.
        `,
      });
      const terminal = await turn;

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );
      const todoCalls = toolCalls.filter((call) => call.name === "todo_write");

      // Primary assertion: the agent picked the state machine. Failing this
      // means the routing prompt or tool descriptions are not strong enough
      // for session-spanning, self-contained multi-step work.
      expect(stateMachineCalls.length).toBeGreaterThanOrEqual(1);
      expect(todoCalls.length).toBe(0);

      const definition = stateMachineCalls[0]?.input?.definition;
      expect(definition).toBeTruthy();
      // The plan must reflect the per-unit structure the user described, not
      // collapse the refactor into one giant state.
      expect(definition.states.length).toBeGreaterThanOrEqual(5);
      // Pure agent (and the eval_done terminal) — no poll/timer should appear
      // for in-conversation refactor work.
      const kinds = new Set<string>(definition.states.map((s: { kind: string }) => s.kind));
      expect(kinds.has("poll")).toBe(false);
      expect(kinds.has("timer")).toBe(false);

      // We told the model to route to a no-op terminal first so we never
      // execute the real refactor states. The turn should still complete.
      expect(terminal.type).toBe("complete");
    },
    120_000,
  );

  testIfDocker.each([
    {
      label: "three small steps",
      prompt: dedent`
        In this conversation, please plan to do three small things one after
        the other: rename the variable foo to bar in src/util.ts, then add a
        one-line comment above its declaration explaining the rename, then
        tell me you are done. I want to watch you work through this list
        right now.
      `,
      maxTodos: 5,
    },
    {
      label: "seven small steps",
      prompt: dedent`
        Please make these seven small edits to src/banner.ts in this conversation:
        1. Change the heading from "Welcome" to "Hello".
        2. Change the subtitle from "Start here" to "Come on in".
        3. Rename the local variable heading to title.
        4. Remove the unused local variable oldSubtitle.
        5. Fix the typo "Welocme" in the comment.
        6. Change the button label from "Submit" to "Continue".
        7. Change the footer text from "Thanks" to "See you soon".
        This is a small one-file copy cleanup. I want to watch the edits here.
      `,
      maxTodos: 9,
    },
  ])(
    "$label routes to todo_write, not a state machine",
    async ({ prompt, maxTodos }) => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are in a planning-only eval. Do not read, edit, or run anything.
          Use exactly one planning tool to register a plan that matches the
          user's request. After the planning tool call, respond with exactly:
          PLAN_REGISTERED
        `,
      });

      const toolCalls: Array<{ name: string; input: any }> = [];
      const todoEvents: TurnTodo[][] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "todos") {
          todoEvents.push(event.todos);
          return;
        }
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call_start") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt,
      });
      const terminal = await turn;

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );
      const todoCalls = toolCalls.filter((call) => call.name === "todo_write");

      // Primary assertion: the agent did not over-reach for a state machine
      // on a tiny in-conversation task. Failing this means the routing
      // guidance is now too aggressive on the state-machine side.
      expect(stateMachineCalls.length).toBe(0);
      expect(todoCalls.length).toBeGreaterThanOrEqual(1);
      // The visible plan should reflect the requested edits.
      const finalTodos = todoEvents.at(-1) ?? [];
      expect(finalTodos.length).toBeGreaterThanOrEqual(2);
      expect(finalTodos.length).toBeLessThanOrEqual(maxTodos);

      expect(terminal.type).toBe("complete");
    },
    120_000,
  );
});
