import { describe, expect } from "bun:test";
import dedent from "dedent";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition, StateMachineState } from "../src/types/state-machine.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/** Requirement tokens. Random enough that a verdict naming one cannot be luck. */
const ALPHA = "STATUS: ALPHA-7Q2";
const BETA = "STATUS: BETA-4X8";
const GAMMA = "STATUS: GAMMA-9Z1";

/**
 * Live end-to-end coverage for the built-in `/goal` skill. The unit test in
 * `test/built-in-skills.test.ts` proves the skill body is discovered and
 * injected; this eval proves the body actually produces the loop it
 * describes — a work state, an evaluator sub-agent that judges the goal
 * against reality, at least one incomplete round that sends the machine
 * back to work, and a terminal only after the evaluator passes.
 *
 * Airtight design: the harness forces exactly one incomplete round without
 * instructing the model at all. The goal is a three-line `report.md`, and
 * the instant the first state agent starts, the harness deletes the GAMMA
 * line the parent just wrote. The parent believes the goal is met and is
 * forbidden from telling a sub-agent what it did, so a first verdict naming
 * GAMMA can ONLY come from a judge that inspected the file rather than
 * trusting the worker — no model obedience required to reproduce it. A run
 * that does the work inline (no skill body) never calls
 * `create_state_machine_definition`; a run whose "evaluator" takes the
 * parent's word never produces the incomplete→complete flip; a run whose
 * park stalls the turn never gets a second evaluation.
 *
 * The system instructions deliberately say nothing about state machines,
 * evaluators, or rounds — every bit of that structure has to come from the
 * skill body, which is what makes the falsification (drop `goal` from
 * BUILT_IN_SKILLS) go red.
 */
describe("/goal loop", () => {
  testIfDocker(
    "builds a work/evaluate state machine that loops on an incomplete verdict and terminates on a pass",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "goal-eval-"));
      const report = join(workDir, "report.md");
      try {
        await writeFile(
          join(workDir, "requirements.md"),
          dedent`
            # Requirements for report.md

            report.md must contain each of these lines, one per line:

            - ${ALPHA}
            - ${BETA}
            - ${GAMMA}
          `,
        );
        await writeFile(report, "");

        const runner = new TurnRunner({
          model,
          mode: "auto",
          cwd: workDir,
          // `includeDefaults: false` skips user/project skill discovery; the
          // built-in `/goal` skill is still merged in by
          // `loadDiscoveredSkills` so the slash token resolves.
          skillDiscovery: { includeDefaults: false },
          systemInstructions: dedent`
            This is a live eval in a sandboxed temp directory. Nothing here is
            production and every file is disposable.

            The user is not present: never ask a question, and drive this to a
            terminal outcome within this turn.

            Never tell a sub-agent what you did, skipped, or plan to do next. A
            sub-agent may receive the goal and its criteria, nothing more.
          `,
        });

        const parentToolCalls: Array<{ name: string; input: any }> = [];
        const subAgentToolCalls: Array<{ name: string; input: any }> = [];
        let clobbered = false;
        let stateStarting = false;
        // The bait: once the first state agent starts, drop GAMMA back out of
        // report.md. The parent wrote that line and has no way to know it
        // vanished, so a first verdict naming GAMMA can only come from a judge
        // that inspected the file instead of trusting the worker.
        const dropGamma = () => {
          const current = readFileSync(report, "utf8");
          if (!current.includes("GAMMA-9Z1")) return;
          writeFileSync(
            report,
            current
              .split("\n")
              .filter((line) => !line.includes("GAMMA-9Z1"))
              .join("\n"),
          );
          clobbered = true;
        };
        runner.subscribe((event: TurnEvent) => {
          if (
            event.type === "task_started" &&
            !clobbered &&
            event.task.label.startsWith("Run state ")
          ) {
            stateStarting = true;
            dropGamma();
            return;
          }
          if (event.type !== "step") return;
          // Re-apply right before the sub-agent's first tool call. A parent that
          // batches its write with the transition lands the file *after* the
          // state starts, which would otherwise hand the judge a complete file
          // and silently turn this into a one-round run.
          if (event.origin && stateStarting && event.step.type === "tool_call_start") {
            stateStarting = false;
            dropGamma();
          }
          const step = event.step;
          if (step.type !== "tool_call_start") return;
          const call = { name: step.toolName, input: step.input };
          if (event.origin) subAgentToolCalls.push(call);
          else parentToolCalls.push(call);
        });

        const { turn } = await startTurn(runner, {
          mode: "auto",
          prompt: "/goal make report.md satisfy every requirement in requirements.md",
        });
        const terminal = await turn;

        // 1. The skill routed the prompt into a state machine at all.
        const creates = parentToolCalls.filter(
          (call) => call.name === "create_state_machine_definition",
        );
        expect(creates.length).toBeGreaterThanOrEqual(1);
        const definition = creates[0]?.input?.definition as StateMachineDefinition | undefined;
        expect(definition).toBeTruthy();
        const states = definition?.states ?? [];
        // 2. Shape: something that evaluates (a sub-agent) plus a completed terminal.
        expect(states.some((state: StateMachineState) => state.kind === "agent")).toBe(true);
        expect(
          states.some(
            (state: StateMachineState) => state.kind === "terminal" && state.status === "completed",
          ),
        ).toBe(true);

        // 3. The evaluator looped: the same agent state ran at least twice,
        //    which only happens when a verdict sent the machine back to work.
        const runs = agentStateRuns(terminal.state);
        const byState = new Map<string, string[]>();
        for (const run of runs) {
          byState.set(run.state, [...(byState.get(run.state) ?? []), run.output]);
        }
        const evaluator = [...byState.entries()].find(([, outputs]) => outputs.length >= 2);
        expect(
          evaluator,
          `Expected one agent state to run at least twice; runs were ${JSON.stringify(
            runs.map((run) => run.state),
          )}`,
        ).toBeTruthy();
        const verdicts = evaluator?.[1] ?? [];

        // 3b. The work really was parent-owned: the machine entered a park and
        //     the parent worked from there. The bait depends on this shape —
        //     it clobbers the file the parent wrote — so a run that delegated
        //     work to a sub-agent instead is not the scenario under test.
        const progress = (terminal.state.stateMachine?.progress?.states ?? {}) as Record<
          string,
          { kind?: string; runs: number }
        >;
        const parkRuns = Object.entries(progress).filter(([, entry]) => entry.kind === "park");
        expect(
          parkRuns.some(([, entry]) => entry.runs >= 1),
          `Expected the machine to enter a park state; progress was ${JSON.stringify(progress)}`,
        ).toBe(true);

        // 4. The first verdict caught the clobbered line — a gap the parent
        //    believed it had already written and never disclosed.
        expect(clobbered).toBe(true);
        const first = verdicts[0] ?? "";
        expect(first.toLowerCase()).toContain("incomplete");
        expect(first).toContain("GAMMA-9Z1");

        // 5. The last verdict passed, and it did so without the word incomplete.
        const last = verdicts[verdicts.length - 1] ?? "";
        expect(last.toLowerCase()).toContain("complete");
        expect(last.toLowerCase()).not.toContain("incomplete");

        // 6. That first verdict came from inspecting reality, not from the
        //    parent's account: a sub-agent read report.md itself.
        const inspected = subAgentToolCalls.filter(
          (call) =>
            (call.name === "read" || call.name === "bash") &&
            JSON.stringify(call.input ?? {}).includes("report.md"),
        );
        expect(
          inspected.length,
          `Expected a sub-agent to inspect report.md; sub-agent calls were ${JSON.stringify(
            subAgentToolCalls.map((call) => call.name),
          )}`,
        ).toBeGreaterThanOrEqual(1);

        // 7. The machine ended at a completed terminal, and the goal is really met.
        expect(terminal.type).toBe("complete");
        expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
        const finalReport = await readFile(report, "utf8");
        for (const requirement of [ALPHA, BETA, GAMMA]) {
          expect(finalReport).toContain(requirement);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    420_000,
  );
});

/** Every completed agent-state run, oldest first, with its output text. */
function agentStateRuns(state: TurnState): Array<{ state: string; output: string }> {
  const definition = state.stateMachine?.definition;
  const agentStates = new Set(
    (definition?.states ?? [])
      .filter((entry: StateMachineState) => entry.kind === "agent")
      .map((entry: StateMachineState) => entry.name),
  );
  const runs: Array<{ state: string; output: string }> = [];
  for (const event of state.stateMachine?.history ?? []) {
    if (event.type !== "state_completed" || !agentStates.has(event.state)) continue;
    const output = event.output;
    const text =
      output &&
      typeof output === "object" &&
      "result" in output &&
      typeof output.result === "string"
        ? output.result
        : output === undefined
          ? ""
          : JSON.stringify(output);
    runs.push({ state: event.state, output: text });
  }
  return runs;
}
