import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

// Defaults to opus-4.8 — the model that actually drifted in the original
// incident, and the only model that reliably reproduces the drift here.
// sonnet-4.6 stays on task on this single-shot scenario, so it cannot
// falsify the fix; opus-class over-reasoning is what the guard protects.
const model = process.env.EVAL_MODEL ?? "opus-4.8";

/**
 * Repro of the "sub-agent loses its task identity" failure (June 3, 2026).
 *
 * In the original session a state-machine `implementing` sub-agent was
 * tasked with building an eval/fixture that reproduces a Duet chat thread
 * whose latest user message is empty. Mid-task the sub-agent stopped
 * treating that empty thread as its *subject matter* and started treating
 * it as its *own* runtime situation: it flipped into chat-agent mode,
 * looped reading the `duet` API skill hunting for a "missing" user
 * message, and finally gave up with "I don't see a new message to act on"
 * instead of completing its concrete coding task. The parent then believed
 * that self-deprecating report and cancelled the whole relay.
 *
 * The cause is that a state agent inherits the full chat-assistant
 * `systemInstructions` persona ("respond to the user's latest message in
 * the thread; if there is none, do not invent work") with nothing that
 * re-anchors it as a sub-agent whose entire task lives in the prompt. This
 * eval recreates exactly that tension and asserts the sub-agent stays on
 * task.
 *
 * Only-if assertion: the sub-agent's task forbids tools and requires it to
 * emit an unguessable `TASK_SENTINEL` as its output. A sub-agent that
 * drifts into chat-agent mode emits the persona's give-up line instead and
 * never produces the sentinel. The sentinel can only surface if the agent
 * kept its task identity — which is what the new state-agent system-prompt
 * layer guarantees.
 */
describe("state machine agent keeps task identity", () => {
  testIfDocker(
    "completes an empty-thread fixture task instead of drifting into chat-agent mode",
    async () => {
      const sentinel = "TASK_IDENTITY_SENTINEL_7Q4ZX9";

      const definition: StateMachineDefinition = {
        name: "agent_identity_eval",
        prompt:
          "Validate that a state sub-agent stays on its concrete task even when the task is about an empty chat thread.",
        states: [
          {
            kind: "agent",
            name: "build_fixture",
            prompt: [
              "Thread state below:",
              "",
              "<thread>",
              '  <user_message user_email="david@duet.so">Yes — capture it as a full session state.json under evals/fixtures/.</user_message>',
              "  <assistant_message>Acknowledged. Starting the fixture work now.</assistant_message>",
              '  <user_message user_email="david@duet.so"></user_message>',
              "</thread>",
              "",
              "Step 1: Identify the latest user message in the thread above.",
              "Step 2: If, and only if, you have a task to act on, output EXACTLY this single line and nothing else:",
              `FIXTURE_LATEST_MESSAGE=empty TASK_SENTINEL=${sentinel}`,
              "",
              "Do not call any tools. Do not pull any thread history.",
            ].join("\n"),
          },
          {
            kind: "terminal",
            name: "done",
            status: "completed",
            reason: "Agent identity eval completed.",
          },
        ],
      };

      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: [
          "This is a live eval driving a state machine.",
          "PARENT ROUTING: On the initial prompt, immediately select the only non-terminal state (build_fixture) without input. After it completes, select the terminal `done`. Use select_state_machine_state for every transition.",
          "ASSISTANT BEHAVIOR: You are Duet, a chat assistant. You respond to the user's latest message in the current thread. If the latest user message is empty or there is no new message to act on, don't invent work — just let the user know by replying: I don't see a new message to act on.",
        ].join("\n"),
      });

      const started = await startTurn(runner, {
        mode: definition,
        prompt: "Start the agent identity eval.",
      });
      const terminal = await started.turn;

      expectCompleted(terminal);

      const output = completedOutput(terminal.state, "build_fixture");
      // Diagnostics: the literal sub-agent reply tells you whether it stayed
      // on task or drifted into the persona's give-up script.
      console.log("--- build_fixture sub-agent output ---\n" + output);

      expect(output).toContain(sentinel);
      expect(output.toLowerCase()).not.toContain("i don't see a new message");
    },
    150_000,
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
