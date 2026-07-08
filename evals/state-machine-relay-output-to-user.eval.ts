import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Regression eval for the wake-on-completion prompt.
 *
 * Real session symptom: a recurring `write_poem` state ran four cycles, but
 * the user never saw any of the poems — only tool-call placeholders and
 * thinking blocks. Root cause: the post-state-completion prompt told the
 * parent "Do not answer normally. Do not return text instead of calling the
 * tool", so the orchestrator went straight from state output to the next
 * `select_state_machine_state` call without relaying anything the user would
 * have wanted to see.
 *
 * The fix loosened that prompt to encourage the parent to post user-facing
 * artifacts produced by a state before/alongside the tool call. This eval
 * locks that behavior in: when a state emits a distinctive marker artifact,
 * the parent's transcript on the wake turn must contain that marker AND the
 * parent must still call `select_state_machine_state` to drive the machine
 * to the terminal.
 */
describe("state machine relays state output to the user", () => {
  testIfDocker(
    "parent posts the produced artifact to the user before transitioning",
    async () => {
      const definition: StateMachineDefinition = {
        name: "relay_output_eval",
        prompt: "Validate that the orchestrator relays user-facing state output on the wake turn.",
        states: [
          {
            kind: "agent",
            name: "write_poem",
            prompt: dedent`
              You are the poem-writing step of a workflow.
              Output a two-line poem. The first line must be exactly:
              POEM-MARKER-QWX-4821
              The second line can be any short poetic line.
              Do not output anything else.
            `,
          },
          {
            kind: "terminal",
            name: "done",
            status: "completed",
            reason: "Relay output eval completed.",
          },
        ],
      };

      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        // The user prompt asks the parent to share what the state produces.
        // The wake-on-completion prompt is what teaches the model to do this
        // even without an explicit ask, so we keep system instructions sparse.
        systemInstructions: dedent`
          This is a live eval. Use the state-machine tools for every
          transition. Run write_poem, then done.
        `,
      });

      const parentTextChunks: string[] = [];
      const selectCalls: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        // Filter to parent-agent text: state-machine agent text carries an
        // origin tag; parent text does not.
        if (event.origin) return;
        const step = event.step;
        if (step.type === "text") parentTextChunks.push(step.text);
        if (step.type === "tool_call_start") {
          selectCalls.push(step.toolName);
        }
      });

      const started = await startTurn(runner, {
        mode: definition,
        prompt: "Run the poem workflow and share what comes out with me.",
      });
      const terminal = await started.turn;

      expectCompleted(terminal);

      // Structural check: the parent still drove the machine via the tool.
      expect(selectCalls).toContain("select_state_machine_state");

      // Behavioral check: the parent's user-facing transcript contains the
      // marker from the state's output. Without the wake-on-completion prompt
      // permitting (and encouraging) a user-visible relay, this fails.
      const parentText = parentTextChunks.join("\n");
      expect(parentText).toContain("POEM-MARKER-QWX-4821");
    },
    180_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}
