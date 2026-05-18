import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Regression eval for the malformed-first-call bug.
 *
 * Observed in a real Duet session (channel j97crd89eb3gq08jm73fsbnehs7s5vv0,
 * 2026-05-18): the model invoked `create_state_machine_definition` with
 * `input: {}` on the first try, got a validation error
 * (`definition: must have required properties definition`), then immediately
 * retried with the correct nested payload. The retry succeeded but the wasted
 * round-trip surfaces every time the model picks the state-machine tool.
 *
 * Hypothesis: the tool description is an outlier in length (~1.5K words) with
 * zero call-shape example. The wrapper (`{ definition: {...}, firstState? }`)
 * is non-obvious — most other tools put meaningful fields at the top level —
 * so the model occasionally serializes the call before the body is ready, or
 * "flattens" the wrapper and emits an empty object.
 *
 * This eval reproduces the exact triggering shape (short user prompt that
 * lands a real fix into a dev worktree → naturally routes through the state
 * machine) and asserts the FIRST `create_state_machine_definition` call
 * carries a populated `definition`, every trial.
 */
// Mirror the real session: short message with only the regression context
// the parent channel surfaced. Keeping it terse is on purpose — the original
// trigger was literally "pls fix" with screenshot context, and longer
// prompts may pre-warm the model away from the streaming malforms.
const TRIGGER_PROMPT = dedent`
  Recent context: PR #1356 just bumped the compose-bar input min-height and
  vertical padding in apps/web/components/chat/compose-bar/primitives/input/compose-bar-input.tsx.
  Now the textarea is too tall and looks even worse with image attachments.

  pls fix — revert that file to the pre-#1356 values, validate, and open a
  PR against staging.
`;

const EVAL_INSTRUCTIONS = dedent`
  You are in a planning-only eval. Do not read, edit, or run anything in
  the real codebase. Use exactly one planning tool to register a plan that
  matches the user's request. If you create a state machine, define a
  terminal state named "eval_done" with status "completed" and pass
  firstState "eval_done" so no real work runs. After the planning tool
  call, respond with exactly: PLAN_REGISTERED
`;

interface CapturedCall {
  toolCallId: string;
  status: "running" | "completed" | "error";
  input?: unknown;
}

async function runOnce(): Promise<CapturedCall[]> {
  const runner = new TurnRunner({
    model,
    mode: "auto",
    skillDiscovery: { includeDefaults: false },
    systemInstructions: EVAL_INSTRUCTIONS,
  });

  const calls: CapturedCall[] = [];
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    const step = event.step;
    if (step.type !== "tool_call") return;
    if (step.toolName !== "create_state_machine_definition") return;
    calls.push({
      toolCallId: step.toolCallId,
      status: step.status as CapturedCall["status"],
      input: (step as { input?: unknown }).input,
    });
  });

  const { turn } = await startTurn(runner, { mode: "auto", prompt: TRIGGER_PROMPT });
  await turn;
  return calls;
}

function firstAttemptShape(calls: CapturedCall[]): {
  attempted: boolean;
  empty: boolean;
  hasDefinition: boolean;
} {
  const firstRunning = calls.find((c) => c.status === "running");
  if (!firstRunning) return { attempted: false, empty: false, hasDefinition: false };
  const input = firstRunning.input as Record<string, unknown> | undefined;
  const empty = !input || Object.keys(input).length === 0;
  const hasDefinition =
    !!input && typeof input === "object" && "definition" in input && !!input.definition;
  return { attempted: true, empty, hasDefinition };
}

describe("create_state_machine_definition call shape", () => {
  // Trials per condition. Stochastic streaming bug — we want enough samples
  // to catch ~10–30% repro rates without burning the eval budget. Each trial
  // is ~$0.05–0.20 on sonnet-4.6 in planning-only mode.
  const TRIALS = Number(process.env.EVAL_CALL_SHAPE_TRIALS ?? 3);

  testIfDocker(
    "first call carries a populated definition every trial",
    async () => {
      const failures: Array<{ trial: number; shape: ReturnType<typeof firstAttemptShape> }> = [];
      let attemptedAny = false;

      for (let trial = 1; trial <= TRIALS; trial++) {
        const calls = await runOnce();
        const shape = firstAttemptShape(calls);
        if (shape.attempted) attemptedAny = true;
        if (!shape.hasDefinition && shape.attempted) {
          failures.push({ trial, shape });
        }
      }

      // Make sure the eval is actually exercising the path we care about — if
      // the model never reaches for the state-machine tool, the routing
      // prompt has drifted and this eval is meaningless.
      expect(attemptedAny).toBe(true);

      // Every attempt's first call must carry a real definition wrapper.
      expect(failures).toEqual([]);
    },
    600_000,
  );
});
