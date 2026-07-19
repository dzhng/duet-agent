import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("parent asks while a state machine is parked", () => {
  testIfDocker(
    "the parent owns the question and routes the later answer out of park",
    async () => {
      const definition: StateMachineDefinition = {
        name: "parent_approval_gate",
        prompt: "Wait for deployment approval.",
        states: [
          { kind: "park", name: "await_approval", when: "Deployment is not approved yet." },
          { kind: "terminal", name: "done", status: "completed" },
          { kind: "terminal", name: "cancelled", status: "cancelled" },
        ],
      };
      const now = Date.now();
      const seededState: TurnState = {
        status: "running",
        mode: definition,
        agent: { status: "running", messages: [] },
        stateMachine: {
          definition,
          prompt: "Wait for deployment approval.",
          currentState: "await_approval",
          history: [
            { type: "state_machine_started", timestamp: now - 2 },
            { type: "state_started", timestamp: now - 1, state: "await_approval" },
          ],
          createdAt: now - 2,
          updatedAt: now - 1,
        },
      };
      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          This is a live eval. The relay is parked at await_approval.
          When asked to request approval, call ask_user_question as the parent
          with one question offering Proceed and Stop. When the later answer is
          Proceed, call select_state_machine_state for done. Do not create or run
          any agent or script states.
        `,
      });
      const parentTools: string[] = [];
      const childTools: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step" || event.step.type !== "tool_call_start") return;
        (event.origin ? childTools : parentTools).push(event.step.toolName);
      });

      await runner.start({ type: "start", mode: definition, state: seededState });
      const asked = await runner.turn({
        type: "prompt",
        message: "Please ask me for deployment approval now.",
        behavior: "follow_up",
      });
      expect(asked.type).toBe("ask");
      expect(parentTools).toContain("ask_user_question");
      expect(childTools).toEqual([]);

      const questions = asked.type === "ask" ? asked.questions : [];
      const terminal = await runner.turn({
        type: "answer",
        questions,
        answers: Object.fromEntries(questions.map((question) => [question.question, ["Proceed"]])),
        behavior: "follow_up",
      });
      expect(parentTools).toContain("select_state_machine_state");
      expect(terminal.state.stateMachine?.terminal?.state).toBe("done");
      expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
    },
    180_000,
  );
});
