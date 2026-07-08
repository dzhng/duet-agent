import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnQuestion, TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Live eval for the answered-ask transition guard.
 *
 * When an agent state calls ask_user_question the machine suspends at that
 * state with no terminal recorded; the user's answer comes back as an ordinary
 * parent prompt. If the orchestrator replies in text without calling
 * select_state_machine_state, the machine would silently stall. The runner
 * detects "answered an ask, owed a transition, emitted none" and re-prompts
 * the parent under a bounded budget, failing the relay with an `error`
 * terminal only if it never advances.
 *
 * Rather than run a real sub-agent to produce the ask, this seeds a session
 * whose history ends at `state_asked_user` (currentState `choose_path`, no
 * terminal) and then drives a single real model answer turn. The system
 * instructions tell the orchestrator to withhold the tool call on the turn
 * that carries the user's answer — simulating the exact stall the guard
 * exists to catch. The only way the machine reaches a terminal from there is
 * the runner's enforcement re-prompt.
 *
 * Falsification: removing the guard call in
 * `runTurnRunnerAgentWithStateMachineTools` makes the answer turn end with no
 * select call and `state.stateMachine.terminal` undefined (a silent stall),
 * which fails the assertions below.
 */
describe("state machine enforces a transition after an answered ask", () => {
  testIfDocker(
    "an answered ask the orchestrator ignores is re-prompted into a real transition",
    async () => {
      const definition: StateMachineDefinition = {
        name: "answered_ask_enforced",
        prompt: "Validate that an answered ask is driven to a transition.",
        states: [
          { kind: "agent", name: "choose_path", prompt: "Ask the user whether to proceed." },
          { kind: "terminal", name: "done", status: "completed" },
          { kind: "terminal", name: "cancelled", status: "cancelled" },
        ],
      };

      const questions: TurnQuestion[] = [
        {
          question: "Should I proceed with the work?",
          options: [{ label: "Proceed" }, { label: "Stop" }],
        },
      ];

      // History ends at the unanswered ask: the asking state was selected,
      // started, and called ask_user_question. No transition or terminal
      // follows, so the runner must treat the next answer as owing a select.
      const now = Date.now();
      const seededState: TurnState = {
        status: "running",
        mode: definition,
        agent: { status: "running", messages: [] },
        stateMachine: {
          definition,
          prompt: "Drive the choose_path question to a terminal.",
          currentState: "choose_path",
          history: [
            { type: "state_machine_started", timestamp: now - 4 },
            { type: "runner_decided", timestamp: now - 3, decision: { state: "choose_path" } },
            { type: "state_started", timestamp: now - 2, state: "choose_path" },
            { type: "state_asked_user", timestamp: now - 1, state: "choose_path", questions },
          ],
          createdAt: now - 4,
          updatedAt: now - 1,
        },
      };

      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          This is a live eval. A relay (state machine) is already running and
          is suspended at the "choose_path" state, which asked the user
          whether to proceed.

          Behave exactly as instructed:
          - On the FIRST turn where the user's message contains their answers
            to that question, reply with one short plain-text sentence
            acknowledging the answer and DO NOT call select_state_machine_state
            on that turn.
          - If you are subsequently re-prompted to make the transition, then
            select "done" when the user chose Proceed, or "cancelled" when the
            user chose Stop.

          Do not invent extra states. Do not ask the user any new questions.
        `,
      });

      const selectCalls: Array<{ state?: string }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step" || event.origin) return;
        const step = event.step;
        if (step.type !== "tool_call_start") return;
        if (step.toolName !== "select_state_machine_state") return;
        const decision = (step.input as { decision?: { state?: string } } | undefined)?.decision;
        selectCalls.push({ state: decision?.state });
      });

      await runner.start({ type: "start", mode: definition, state: seededState });
      const terminal = await runner.turn({
        type: "answer",
        questions,
        answers: { "Should I proceed with the work?": ["Proceed"] },
        behavior: "follow_up",
      });

      // The orchestrator withheld the tool on the answer turn, so the only way
      // a select call for the Proceed->done transition exists is the runner's
      // enforcement re-prompt firing. Without the guard there are no select
      // calls at all.
      expect(selectCalls.map((call) => call.state)).toContain("done");

      // The machine must have reached the `done` terminal rather than silently
      // stalling at choose_path. Without the guard, `terminal` is undefined.
      expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
      expect(terminal.state.stateMachine?.terminal?.state).toBe("done");
    },
    180_000,
  );
});
