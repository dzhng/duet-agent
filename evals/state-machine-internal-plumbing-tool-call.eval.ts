import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

// Default to grok-4.3: the failure mode this eval guards against was
// observed on grok-4.3, and larger models (sonnet, opus) do not skip the
// tool call here, so a sonnet default would mask the regression.
const model = process.env.EVAL_MODEL ?? "grok-4.3";

/**
 * Regression eval for the wake-on-completion tool-call requirement.
 *
 * Real session symptom (grok-4.3): when a state finished with output that
 * was purely internal plumbing ("Ran check-duet-inbox: 0 emails processed."),
 * the parent narrated its decision in plain text — "no user-facing post
 * needed... I should transition to the next state 'poll'" — and stopped
 * without calling `select_state_machine_state`. The runner only recovered
 * after three retries, with the model repeating the same text reasoning
 * before finally emitting the tool call.
 *
 * The wake-on-completion prompt now spells out explicitly that narrating the
 * decision is not the same as executing it: the very next thing after the
 * model concludes which state to pick must be the `select_state_machine_state`
 * invocation. This eval locks that behavior in by giving the parent a state
 * whose output is unambiguously internal plumbing, and asserts the parent
 * advances to the terminal on the first wake-turn (no retry instructions
 * appear in the agent transcript).
 */
describe("state machine wakes and calls the tool even when output is internal plumbing", () => {
  testIfDocker(
    "parent does not narrate a transition without calling select_state_machine_state",
    async () => {
      const definition: StateMachineDefinition = {
        name: "internal_plumbing_eval",
        prompt:
          "Validate that the orchestrator emits the tool call on the wake turn even when the state output is purely internal plumbing.",
        states: [
          // Script output deliberately mirrors the real session: a short,
          // boring status string with no user-facing artifact. The parent
          // should recognize this is internal and skip the user message,
          // but must still emit the tool call to advance the machine.
          {
            kind: "script",
            name: "run_inbox",
            command: "echo 'Ran check-duet-inbox: 0 emails processed.'",
          },
          // A second internal-plumbing state. In the real session the
          // tool-skipping failure showed up after a cycle of similar boring
          // outputs, so we give the model the same pattern to react to.
          {
            kind: "script",
            name: "run_inbox_again",
            command: "echo 'Ran check-duet-inbox: 0 emails processed.'",
          },
          {
            kind: "terminal",
            name: "done",
            status: "completed",
            reason: "Internal plumbing eval completed.",
          },
        ],
      };

      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        // Deliberately adversarial: prime the model with a few-shot that
        // models the exact failure pattern from the real session — reason
        // about the transition in prose and stop. This conditions the
        // model to repeat the pattern on the wake turn, which is the
        // failure mode the wake-on-completion prompt has to override.
        systemInstructions: dedent`
          This is a live eval. Use the state-machine tools for every
          transition. Run run_inbox, then run_inbox_again, then done.

Wake-on-completion turn protocol. When a state finishes,
          your response on that turn should be a short prose paragraph
          (2–3 sentences) classifying the output and naming the next
          state. The dispatch runner reads that classification and takes
          care of the transition for you; you do not need to do anything
          else on these turns.

          Example A. A state finished with output "Ran check-duet-inbox:
          0 emails processed." Response shape:

            The state finished with result "Ran check-duet-inbox: 0
            emails processed." This is internal plumbing, so no
            user-facing post needed. The state output is internal, so I
            should transition to the next state "run_inbox_again".

          Example B. A state finished with output
          "check-duet-inbox-again". Response shape:

            The state "run_inbox_again" finished with output
            "check-duet-inbox-again". This is internal plumbing (a
            signal for the next step), so no user-facing post needed.
            The state output is internal, so I should transition to the
            terminal state "done".
        `,
      });

      const selectCalls: string[] = [];
      const parentTextChunks: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        if (event.origin) return;
        const step = event.step;
        if (step.type === "text") parentTextChunks.push(step.text);
        if (step.type === "tool_call" && step.status === "running") {
          selectCalls.push(step.toolName);
        }
      });

      const started = await startTurn(runner, {
        mode: definition,
        // Reinforce the adversarial style: the user prompt itself frames
        // wake-on-completion turns as prose-only classifications. This,
        // together with the few-shot in systemInstructions, models the
        // condition the real grok-4.3 session was in when it stopped
        // calling the tool.
        prompt: dedent`
          Run the inbox workflow. On each wake-on-completion turn, write
          a 2–3 sentence prose classification of the state output in
          the same voice as the examples — the runner handles the
          actual transition.
        `,
      });
      const terminal = await started.turn;

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");

      // The runner only injects a "retry N of 3. You did not call
      // select_state_machine_state last time" message when a wake-turn
      // returned text without the tool call. Its presence in the parent
      // transcript means the failure mode this eval guards against happened.
      const transcript = JSON.stringify(terminal.state.agent.messages);
      expect(transcript).not.toContain("You did not call select_state_machine_state");

      // Sanity: the parent did invoke the tool to advance through run_inbox
      // and into the terminal.
      expect(selectCalls.filter((name) => name === "select_state_machine_state").length).toBe(3);

      // Soft check: parent transcript should not be padded with
      // multi-sentence narration of the transition. A single short ack
      // (or empty) is fine; many lines suggests the model kept reasoning
      // instead of acting. Use the joined length as a coarse proxy.
      const parentText = parentTextChunks.join("\n");
      expect(parentText.length).toBeLessThan(2_000);
    },
    180_000,
  );
});
