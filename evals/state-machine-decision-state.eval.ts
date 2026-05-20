import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "gpt-5.5";

/**
 * Regression eval for `select_state_machine_state` guessing loops.
 *
 * Originally observed in a real Duet session (gpt-5.5, chat-app channel,
 * 2026-05-20): the model invoked `select_state_machine_state` over and
 * over with malformed `decision.kind` strings ("Select", "Continue",
 * "Transition", ...) and never recovered. That bug class was resolved by
 * dropping `decision.kind` from the schema entirely \u2014 a decision is now
 * just `{ state, reason?, override?, input? }`, and the state's own kind
 * in the definition (agent/script/poll/timer/terminal) drives dispatch.
 *
 * The same guessing failure mode can still appear on `decision.state`:
 * if the model invents state names that aren't in the active definition,
 * it loops the same way \u2014 every call is rejected with `Unknown state: X.
 * Valid states: ...` and the next call must pick from that list. This
 * eval guards that recovery path: priming the assistant transcript with
 * three failed select calls that name fabricated states, then steering
 * gpt-5.5 to retry, must produce a call whose `state` is in the active
 * definition.
 */

const DEFINITION: StateMachineDefinition = {
  name: "cool_thing_every_6h",
  prompt: "Every 6 hours, produce one short cool thing for the user. Continue indefinitely.",
  states: [
    {
      kind: "agent",
      name: "make-cool-thing",
      prompt: "Produce one short cool thing for the user. End with an emoji.",
    },
    {
      kind: "timer",
      name: "wait-six-hours",
      // 6 hours from a fixed reference point; the exact value doesn't
      // matter for this eval \u2014 only the shape does.
      wakeAt: Date.now() + 6 * 60 * 60 * 1000,
    },
    {
      kind: "terminal",
      name: "done",
      status: "completed",
    },
  ],
};

// State names the model invents in the priming history. None of these
// appear in DEFINITION, so each one triggers the "Unknown state" error
// from `assertValidSelectedState` / the controller's findState check.
const FAKE_STATES = ["wait_6h", "waitSixHours", "WaitForTimer"];

// Every state name the model is allowed to select on the recovery turn.
// `failed` and `cancelled` are auto-injected into the definition so they
// belong in the valid set even though they aren't listed above.
const VALID_STATE_NAMES = new Set<string>([
  ...DEFINITION.states.map((state) => state.name),
  "failed",
  "cancelled",
]);

function buildSeededState(): TurnState {
  const now = Date.now();
  const createToolCallId = "call_create";
  const messages: TurnState["agent"]["messages"] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "can you create a state machine that does something cool every 6 hrs?",
        },
      ],
      timestamp: now - 60_000,
    },
    createAssistantMessage({
      timestamp: now - 55_000,
      extraContent: [
        {
          type: "toolCall",
          id: createToolCallId,
          name: "create_state_machine_definition",
          arguments: {
            definition: DEFINITION,
            firstState: "make-cool-thing",
          },
        },
      ],
    }),
    {
      role: "toolResult",
      toolCallId: createToolCallId,
      toolName: "create_state_machine_definition",
      content: [{ type: "text", text: '{"ok":true,"firstState":"make-cool-thing"}' }],
      isError: false,
      timestamp: now - 54_000,
    },
  ];

  // Three failed select_state_machine_state attempts naming fake states,
  // each paired with the runner's "Unknown state" error message so the
  // recovery turn has been told (three times) what the valid set is.
  FAKE_STATES.forEach((fakeState, idx) => {
    const id = `call_select_${idx}`;
    messages.push(
      createAssistantMessage({
        timestamp: now - 50_000 + idx * 1000,
        extraContent: [
          {
            type: "toolCall",
            id,
            name: "select_state_machine_state",
            arguments: { decision: { state: fakeState } },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "select_state_machine_state",
        content: [
          {
            type: "text",
            text: `Unknown state: ${fakeState}. Valid states: ${[...VALID_STATE_NAMES].join(", ")}`,
          },
        ],
        isError: true,
        timestamp: now - 50_000 + idx * 1000 + 500,
      },
    );
  });

  return {
    status: "running",
    mode: "auto",
    agent: {
      status: "running",
      messages,
    },
    stateMachine: {
      definition: DEFINITION,
      prompt: DEFINITION.prompt,
      currentState: "wait-six-hours",
      currentInput: {},
      history: [],
      createdAt: now - 55_000,
      updatedAt: now - 50_000,
    },
  };
}

interface CapturedSelect {
  state: unknown;
}

async function runOnce(): Promise<{
  selects: CapturedSelect[];
  terminal: TurnTerminalEvent;
}> {
  const runner = new TurnRunner({
    model,
    mode: "auto",
    skillDiscovery: { includeDefaults: false },
  });

  const selects: CapturedSelect[] = [];
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    const step = event.step;
    if (step.type !== "tool_call") return;
    if (step.status !== "running") return;
    if (step.toolName !== "select_state_machine_state") return;
    const input = (step as { input?: unknown }).input as
      | { decision?: { state?: unknown } }
      | undefined;
    selects.push({ state: input?.decision?.state });
  });

  await runner.start({ type: "start", mode: "auto", state: buildSeededState() });
  const terminal = await runner.turn({
    type: "prompt",
    message:
      "Your previous select_state_machine_state calls all failed validation. Call select_state_machine_state now to advance the cool-thing relay to its timer state.",
    behavior: "follow_up",
  });
  return { selects, terminal };
}

describe("select_state_machine_state decision.state shape", () => {
  // Priming should make this near-deterministic, so a small N is enough.
  const TRIALS = Number(process.env.EVAL_DECISION_STATE_TRIALS ?? 3);

  testIfDocker(
    "every select call names a state from the active definition",
    async () => {
      const badPerTrial: Array<{ trial: number; bad: CapturedSelect[] }> = [];
      let sawSelect = false;

      for (let trial = 1; trial <= TRIALS; trial++) {
        const { selects } = await runOnce();
        if (selects.length > 0) sawSelect = true;
        const bad = selects.filter(
          (s) => typeof s.state !== "string" || !VALID_STATE_NAMES.has(s.state),
        );
        if (bad.length > 0) badPerTrial.push({ trial, bad });
      }

      // Sanity check that the priming still gets gpt-5.5 to attempt a
      // select. If this fails the steering prompt has drifted.
      expect(sawSelect).toBe(true);

      expect(badPerTrial).toEqual([]);
    },
    600_000,
  );
});
