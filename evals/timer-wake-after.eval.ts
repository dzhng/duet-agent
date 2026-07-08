import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Routing eval for the timer `wakeAfterMs` field added in PR #58.
 *
 * Timer states accept either `wakeAt` (absolute Unix-epoch ms or ISO 8601)
 * or `wakeAfterMs` (relative duration measured from selection time, accepting
 * `ms`-style strings like `"16h"` or a raw millisecond number). When the user
 * frames a wait in relative terms ("wait 16 hours, then check…"), the agent
 * should pick `wakeAfterMs`, not compute an absolute `wakeAt` itself: the
 * relative form is what the schema is built for, it makes the definition
 * reusable, and it sidesteps drift between when the agent renders the prompt
 * and when the parent actually selects the state.
 *
 * This eval drives a planning-only turn: the agent registers the state
 * machine but its `firstState` is the `eval_done` terminal, so no real wait
 * runs. The assertion is on the *definition* that landed in the tool call.
 */
describe("timer wakeAfterMs routing", () => {
  testIfDocker(
    "uses wakeAfterMs (not wakeAt) when the wait is described as a relative duration",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
          You are in a planning-only eval. You cannot call bash, read, edit,
          write, or any other coding tool — those would touch real systems
          you do not control here. You CAN call
          create_state_machine_definition and todo_write.

          The user's request below is exactly the kind of wait-then-do work
          that needs a relay (state machine) with a timer state. Set one up.
          Include a terminal state named "eval_done" with status "completed"
          so the relay has a happy-path exit, but pick the firstState that
          matches what the user actually asked for. Reply with a short
          status update afterwards describing what you scheduled.
        `,
      });

      const toolCalls: Array<{ name: string; input: unknown }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type === "tool_call_start") {
          toolCalls.push({ name: step.toolName, input: step.input });
        }
      });

      const { turn } = await startTurn(runner, {
        mode: "auto",
        prompt: dedent`
          Wait 16 hours, then post a follow-up message in this channel
          summarizing the overnight CI runs. The wait length is fixed (16h
          from now), not tied to a specific clock time — set up the relay so
          the timer survives the session boundary and the follow-up agent
          state runs after the wait completes.
        `,
      });
      const terminal = await turn;

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );
      expect(stateMachineCalls.length).toBeGreaterThanOrEqual(1);

      const definition = (stateMachineCalls[0]?.input as { definition?: PlanDefinition })
        ?.definition;
      expect(definition).toBeTruthy();
      if (!definition) throw new Error("missing definition");

      const timerStates = definition.states.filter((s) => s.kind === "timer");
      // The whole point of the prompt is the wait. There must be a timer.
      expect(timerStates.length).toBeGreaterThanOrEqual(1);

      const timer = timerStates[0];
      if (!timer) throw new Error("expected at least one timer state");

      // Primary assertion: the relative-wait prompt routed to wakeAfterMs,
      // not wakeAt. Failing this means the prompt/tool guidance isn't
      // pointing the model at the relative form for "wait N hours" framing.
      expect(timer.wakeAfterMs).toBeDefined();
      expect(timer.wakeAt).toBeUndefined();

      // The duration should resolve to ~16h. Accept either a duration string
      // ("16h", "16 hours") or a raw millisecond number; both are valid
      // per-schema, and we want this eval to track behavior, not surface
      // syntax.
      const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
      const resolved = resolveDurationMs(timer.wakeAfterMs);
      expect(resolved).toBeGreaterThanOrEqual(SIXTEEN_HOURS_MS - 5 * 60_000);
      expect(resolved).toBeLessThanOrEqual(SIXTEEN_HOURS_MS + 5 * 60_000);

      // The turn ends in `sleep` when the agent wires the timer as the
      // firstState (the relay is genuinely waiting), or in `complete` when
      // the agent created the relay but did not enter the wait this turn.
      // Either form is acceptable — the wakeAfterMs routing assertions
      // above are what we actually care about.
      expect(["complete", "sleep"]).toContain(terminal.type);
    },
    120_000,
  );
});

interface PlanState {
  kind: string;
  name: string;
  wakeAt?: number | string;
  wakeAfterMs?: number | string;
}
interface PlanDefinition {
  states: PlanState[];
}

// Minimal subset of the `ms` parser sufficient for the formats the model
// realistically emits for "16h": raw number, "16h", "16 hours", "960m",
// "57600s". Anything outside that surface should fail the assertion loudly
// rather than be silently coerced.
function resolveDurationMs(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") {
    throw new Error(`wakeAfterMs must be a number or string; got ${typeof value}`);
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) throw new Error(`Unrecognized duration string: ${value}`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
  };
  const factor = unitMs[unit];
  if (factor === undefined) throw new Error(`Unrecognized duration unit: ${unit}`);
  return n * factor;
}
