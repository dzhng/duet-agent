import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const PARK_NUDGE_SENTINELS = [
  'The state machine is parked at "await_go_ahead".',
  "you may end your turn and the machine stays parked.",
];

function transcriptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(transcriptText).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(transcriptText)
      .join("\n");
  }
  return "";
}

describe("state machine park", () => {
  testIfDocker(
    "park is taskless, nudged every turn, and a later go-ahead advances it",
    async () => {
      const definition: StateMachineDefinition = {
        name: "park_until_go_ahead",
        prompt: "Wait for the user's explicit go-ahead.",
        states: [
          { kind: "park", name: "await_go_ahead", when: "No go-ahead has arrived." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      };
      const runner = new TurnRunner({
        model,
        mode: definition,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          This is a live eval. On the first turn select await_go_ahead. While the
          user says to keep waiting, leave the relay parked and do not run work.
          When the user says GO AHEAD, select done. Use only
          select_state_machine_state; do not create a replacement relay.
        `,
      });
      const taskStarts: TurnEvent[] = [];
      const selectedStates: Array<string | undefined> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "task_started") taskStarts.push(event);
        if (event.type !== "step" || event.origin || event.step.type !== "tool_call_start") return;
        if (event.step.toolName !== "select_state_machine_state") return;
        const input = event.step.input as { decision?: { state?: string } } | undefined;
        selectedStates.push(input?.decision?.state);
      });

      await runner.start({ type: "start", mode: definition });
      const parked = await runner.turn({
        type: "prompt",
        message: "Start the relay and wait for my go-ahead.",
        behavior: "follow_up",
      });
      expect(parked.state.stateMachine?.currentState).toBe("await_go_ahead");
      expect(taskStarts).toEqual([]);
      for (const sentinel of PARK_NUDGE_SENTINELS) {
        expect(transcriptText(parked.state.agent.messages)).toContain(sentinel);
      }
      const parkedMessageCount = parked.state.agent.messages.length;

      const stillParked = await runner.turn({
        type: "prompt",
        message: "Keep waiting. Approval has not arrived.",
        behavior: "follow_up",
      });
      expect(stillParked.state.stateMachine?.currentState).toBe("await_go_ahead");
      expect(taskStarts).toEqual([]);
      for (const sentinel of PARK_NUDGE_SENTINELS) {
        expect(
          transcriptText(stillParked.state.agent.messages.slice(parkedMessageCount)),
        ).toContain(sentinel);
      }

      const done = await runner.turn({
        type: "prompt",
        message: "GO AHEAD.",
        behavior: "follow_up",
      });
      expect(selectedStates).toContain("await_go_ahead");
      expect(selectedStates).toContain("done");
      expect(done.state.stateMachine?.terminal?.state).toBe("done");
      expect(taskStarts).toEqual([]);
    },
    180_000,
  );
});
