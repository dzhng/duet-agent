import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Replay of session `c_cGfNEIotLU` ("Investigate corrupted memory DBs") with
 * the original user prompt, definition name, state names, and the literal
 * third-state prompt. The first two agent states are replaced with script
 * states that print the verbatim outputs the real sub-agents produced (stored
 * under `evals/fixtures/session-c_cGfNEIotLU/`), so the parent receives the
 * exact compact results the real orchestrator did.
 *
 * The original orchestrator transitioned to `fix_and_recover` without
 * amending the static prompt that vaguely referenced "the findings from the
 * survey" / "the corrupted DBs found earlier". The fresh sub-agent could not
 * see those findings and asked the user three clarifying questions — the
 * observable form of the carry-forward bug. The user then re-ran the state
 * with a long `override.prompt` inlining the survey + diagnose findings.
 *
 * This eval asserts the fixed flow: at transition time, the parent must
 * inline concrete findings (PGlite, the embedding-worker FK race, the
 * specific repo paths, the open-race root cause) via `override.prompt` or
 * `input`, so the third sub-agent can act without re-asking the user.
 */
describe("state machine real session c_cGfNEIotLU carry-forward", () => {
  testIfDocker(
    "replays the corrupted-memory-db investigation and carries findings into fix_and_recover",
    async () => {
      const recoverDir = await mkdtemp(join(tmpdir(), "sm-recover-"));
      const fixtureDir = join(import.meta.dir, "fixtures/session-c_cGfNEIotLU");
      try {
        const definition: StateMachineDefinition = {
          name: "Investigate corrupted memory DBs",
          prompt:
            "Find the root cause of corrupted memory databases under ~/.duet, reproduce the failure mode, determine whether embeddings are involved, fix the source issue, and attempt to recover data from existing corrupted DBs.",
          states: [
            // The original first two states were agent states; replacing them
            // with script states that print the recorded verbatim outputs
            // keeps the eval cheap and deterministic while preserving the
            // exact compact result the original orchestrator saw.
            {
              kind: "script",
              name: "survey_corruption",
              cwd: fixtureDir,
              command: "cat survey_corruption.txt",
            },
            {
              kind: "script",
              name: "reproduce_and_diagnose",
              cwd: fixtureDir,
              command: "cat reproduce_and_diagnose.txt",
            },
            {
              kind: "agent",
              name: "fix_and_recover",
              cwd: recoverDir,
              // Verbatim prompt from the original session. The static phrases
              // "Fix the root cause" and "corrupted DBs found earlier" have
              // no concrete antecedent inside a fresh sub-agent context —
              // the parent must carry the survey + diagnose findings forward
              // via override.prompt or input when selecting this state.
              prompt:
                "Fix the root cause in the repo (smallest correct change, follow AGENTS.md: no thin wrappers, keep names current, run typecheck + lint + relevant tests; file-writing tests via docker). Then write a recovery script that opens each corrupted DB read-only, dumps recoverable rows (try `.recover` and `.dump`, and row-by-row SELECT with error skipping), and reinserts them into a fresh DB at the same path (after backing the corrupted file aside to `<path>.corrupt-<timestamp>`). Run the recovery against the actual corrupted DBs found earlier and report rows recovered vs rows lost per DB. Return: commit-ready summary of the fix, verification output (typecheck/lint/tests), and recovery stats.",
              // Bound the sub-agent for eval cost. The carry-forward decision
              // we are measuring happens at transition time, before this
              // sub-agent runs; this systemPrompt only keeps the actual run
              // cheap and assertable.
              systemPrompt: dedent`
                You are inside a live eval. Do not call any tools. Do not
                modify any files. Do not ask the user questions — if the
                prompt is missing context, that is itself a failure. Reply
                with one short paragraph that names the concrete root cause
                you would fix and the concrete repo file(s) you would touch,
                based only on what is in your prompt.
              `,
            },
            { kind: "terminal", name: "done", status: "completed" },
            { kind: "terminal", name: "failed", status: "failed" },
            { kind: "terminal", name: "cancelled", status: "cancelled" },
          ],
        };

        const runner = new TurnRunner({
          model,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          // Deliberately minimal: no instructions about carrying findings
          // forward. The only signal is the default state-machine prompt
          // layer and the select_state_machine_state tool description, which
          // is what this eval validates.
          systemInstructions: dedent`
            This is a live eval replay of a real session. Use the
            state-machine tools for every transition. Select
            survey_corruption first, then reproduce_and_diagnose, then
            fix_and_recover, then done. Do not invent extra states and do
            not ask the user any questions yourself.
          `,
        });

        const selectCalls: Array<{ input: unknown }> = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          const step = event.step;
          if (step.type !== "tool_call" || step.status !== "running") return;
          if (step.toolName !== "select_state_machine_state") return;
          selectCalls.push({ input: step.input });
        });

        // The exact verbatim user prompt from session_c_cGfNEIotLU. The
        // <system-reminder> "relay mode" wrapper is preserved because it is
        // part of the recorded turn that produced the failure mode.
        const userPrompt = dedent`
          figure out where your corrupted memory dbs under ~/.duet is coming from, try to reproduce the error. is it because of embeddings? if you find the issue, fix it, and try to recover the memories from the corrupted dbs

          <system-reminder>
          The user requested relay mode for this prompt. Strongly prefer the state-machine tools (create_state_machine_definition or select_state_machine_state) over handling the work inline. If no state machine is active, create one with agent/script/poll/terminal states sized to the request. If one is active, select the next state instead of replying directly. Only fall back to a plain answer when the request is genuinely a one-shot question that cannot be expressed as a state.
          </system-reminder>
        `;

        const started = await startTurn(runner, {
          mode: definition,
          prompt: userPrompt,
        });
        const terminal = await started.turn;

        expect(terminal.type).toBe("complete");

        // Locate the transition into fix_and_recover and confirm it inlined
        // concrete findings the fresh sub-agent could not otherwise see.
        const fixSelect = selectCalls.find((call) => {
          const decision = (call.input as { decision?: { state?: string } } | undefined)?.decision;
          return decision?.state === "fix_and_recover";
        });
        expect(fixSelect).toBeTruthy();
        const decision = (
          fixSelect?.input as {
            decision?: {
              override?: { state?: { prompt?: string } };
              input?: Record<string, unknown>;
            };
          }
        )?.decision;
        const overridePrompt = decision?.override?.state?.prompt ?? "";
        const inputValues = JSON.stringify(decision?.input ?? {});
        const carried = `${overridePrompt}\n${inputValues}`.toLowerCase();

        // The parent must inline at least one repo-specific file path from
        // the survey output. "Findings from the previous step" with no
        // carry-forward leaves the sub-agent blind to where to apply the
        // fix.
        expect(carried).toContain("pglite");
        expect(carried).toMatch(/src\/memory\/pglite\.ts/);

        // The diagnose output identified a process-level open race as the
        // root cause. That fact only exists in the previous state's output
        // and must reach the third sub-agent.
        expect(carried).toMatch(/race|concurrent|postmaster|open|migration/);

        // Structural check on the recorded state history: the third state
        // actually ran (not skipped or failed before execution). The primary
        // assertion above already proved the carry-forward landed in the
        // select call's input or override; we do not also gate on the
        // bounded sub-agent's free-form reply, which is too noisy for an
        // eval signal.
        const history = terminal.state.stateMachine?.history ?? [];
        const fixOutput = history.find(
          (event) => event.type === "state_completed" && event.state === "fix_and_recover",
        );
        expect(fixOutput).toBeTruthy();
      } finally {
        await rm(recoverDir, { recursive: true, force: true });
      }
    },
    480_000,
  );
});
