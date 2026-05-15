import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Each agent state runs in a fresh sub-agent context that cannot see the prior
 * state's transcript or output. The orchestrator is responsible for carrying
 * facts forward when it transitions — either via `input` on a state that
 * declares an inputSchema, or via `override.prompt` on a state whose static
 * prompt only vaguely references "the findings from the previous step".
 *
 * This eval models the failure mode observed in session `c_cGfNEIotLU`, where
 * a three-state plan had the second state's prompt say "Using the findings
 * from the survey" without inputs or an override. The sub-agent had no way to
 * read those findings, and the parent never amended the transition.
 *
 * The state machine here intentionally defines no inputSchema and a static
 * second-state prompt with the same shape, so the only path to a successful
 * recall is for the parent to use `override.prompt` when selecting the second
 * state and inline the codename that the first state surfaced.
 */
describe("state machine transition carry-forward", () => {
  testIfDocker(
    "parent inlines prior state findings into the next agent state's prompt",
    async () => {
      const definition: StateMachineDefinition = {
        name: "transition_carry_forward_eval",
        prompt:
          "Validate that the orchestrator carries discovered facts forward into the next state's prompt or input.",
        states: [
          {
            kind: "agent",
            name: "discover_codename",
            prompt: dedent`
              You are the discovery step of a two-step workflow.
              Reply with exactly this single line and nothing else:
              CODENAME=ZEPHYR-7421-OPAL
            `,
          },
          {
            kind: "agent",
            name: "recall_codename",
            // No inputSchema and a static prompt that vaguely references prior
            // findings. The sub-agent cannot see the previous state's output,
            // so the only path to a correct answer is for the parent to
            // override this prompt at transition time with the actual value.
            prompt: dedent`
              Repeat the codename that the previous discovery step surfaced.
              Reply with exactly the codename on a single line and nothing else.
            `,
          },
          {
            kind: "terminal",
            name: "done",
            status: "completed",
            reason: "Transition carry-forward eval completed.",
          },
        ],
      };

      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        // Intentionally do NOT tell the model to override the prompt or carry
        // the codename forward. The only signal it has is the default
        // state-machine routing prompt and the select_state_machine_state tool
        // description, which is what this eval is tuning.
        systemInstructions: dedent`
          This is a live eval. Use the state-machine tools for every
          transition. Select discover_codename first, then recall_codename,
          then done. Do not ask the user questions and do not invent extra
          states.
        `,
      });

      const selectCalls: Array<{ name: string; input: unknown }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call" || step.status !== "running") return;
        if (step.toolName !== "select_state_machine_state") return;
        selectCalls.push({ name: step.toolName, input: step.input });
      });

      const started = await startTurn(runner, {
        mode: definition,
        prompt: "Run the two-step codename workflow.",
      });
      const terminal = await started.turn;

      expectCompleted(terminal);

      // Primary behavioral assertion: the second sub-agent surfaced the
      // codename. That can only happen if the parent inlined it into the
      // recall_codename prompt via override.prompt (or input + matching
      // template) at transition time. A static prompt that says "the
      // codename from the previous step" with no carry-forward leaves the
      // sub-agent blind and this assertion fails.
      expect(completedOutput(terminal.state, "recall_codename")).toContain("ZEPHYR-7421-OPAL");

      // Structural check: the recall transition must have been amended in
      // some way that carries the codename. We accept either an
      // `override.prompt` that includes the value, or an `input` object
      // whose values include it (in case the model decided to amend the
      // state's inputSchema and prompt template via override).
      const recallSelect = selectCalls.find((call) => {
        const decision = (call.input as { decision?: { state?: string } } | undefined)?.decision;
        return decision?.state === "recall_codename";
      });
      expect(recallSelect).toBeTruthy();
      const decision = (
        recallSelect?.input as {
          decision?: {
            override?: { state?: { prompt?: string } };
            input?: Record<string, unknown>;
          };
        }
      )?.decision;
      const overridePrompt = decision?.override?.state?.prompt ?? "";
      const inputValues = Object.values(decision?.input ?? {})
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      const carriedForward = `${overridePrompt}\n${inputValues}`;
      expect(carriedForward).toContain("ZEPHYR-7421-OPAL");
    },
    180_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function completedOutput(state: TurnState, selectedState: string): string {
  const history = state.stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index] as StateMachineSessionEvent;
    if (event.type === "state_completed" && event.state === selectedState) {
      const output = event.output;
      if (
        output &&
        typeof output === "object" &&
        "result" in output &&
        typeof output.result === "string"
      ) {
        return output.result;
      }
      return output === undefined ? "" : JSON.stringify(output);
    }
  }
  throw new Error(`Expected state_completed for ${selectedState}`);
}
