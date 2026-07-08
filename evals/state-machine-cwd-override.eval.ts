import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Regression guard for the state-machine cwd-carry contract, modeled on the
 * chat-app feature-delivery relay where work moves from a base checkout into a
 * git worktree mid-flow.
 *
 * `implement` provisions a worktree at runtime and prints its path; that path
 * lives in no prompt. The steps after it operate on the worktree, the steps
 * before it on the base checkout. The contract under guard: the orchestrator
 * carries implement's returned path forward as `override.cwd` on the
 * worktree-scoped steps, and leaves the base-checkout steps on the session cwd.
 *
 * Each step also quotes a sentinel file to prove which checkout it ran in — the
 * worktree sentinels exist only inside the worktree, the base sentinel only in
 * the base checkout — so the behavioral assertions confirm the cwd actually
 * took effect end to end.
 *
 * Note on falsifiability: the original intent was to reproduce a production
 * failure where the orchestrator inlined the worktree path into a large
 * authored `override.prompt` and forgot `override.cwd`. That shape could not be
 * reproduced on the tested models — they reliably set `override.cwd` (haiku
 * does not even author a prompt override; it uses input + cwd directly). The
 * eval is kept as a green guard for the carry-as-cwd contract rather than a red
 * repro, since the failure only manifests on reasoning-heavier runs than this
 * harness exercises.
 */
describe("state machine carries a runtime worktree path forward as override.cwd", () => {
  testIfDocker(
    "sets override.cwd to implement's returned worktree path on the worktree-scoped steps, not on the base steps",
    async () => {
      const baseDir = await mkdtemp(join(tmpdir(), "sm-cwd-base-"));

      const markers = {
        base: "BASE-CHECKOUT-1042",
        ui_playground: "PLAYGROUND-WT-3318",
        reviewing: "REVIEW-WT-4405",
        pr_open: "PROPEN-WT-5590",
      } as const;

      try {
        await writeFile(join(baseDir, "shared.txt"), markers.base);

        const branch = "walter/channel-details-dialog-folder-picker";

        // A real-reading task prompt for one workflow step. The rehearsal
        // framing keeps sub-agents cheap and deterministic instead of running
        // real builds/gh; the sentinel quote is the behavioral proof of which
        // checkout the sub-agent operated in.
        const step = (task: string, sentinel: string) =>
          dedent`
            ${task}

            This is a rehearsal pass: describe what you would change in two or
            three sentences rather than running any build, test, git, or gh
            commands or editing files. You MUST, however, read the file
            ${sentinel} — a plain file read, not a build step — and quote its
            exact contents verbatim as the final line of your report, since that
            is how the workflow confirms which checkout you ran in.
          `;

        const definition: StateMachineDefinition = {
          name: "channel_details_dialog_rework",
          prompt:
            "Drive the channel-details dialog rework: plan it, add shared-component coverage, build the feature in a worktree, then add new-component coverage, review, and open a PR.",
          states: [
            {
              kind: "agent",
              name: "plan",
              prompt: step(
                "Lock the channel-details dialog rework: a sticky-header scrollable dialog and a workDir folder picker that extends MoveToPicker with a gated pick-directory mode.",
                "shared.txt",
              ),
            },
            {
              kind: "agent",
              name: "scaffold",
              prompt: step(
                "Stub the design-system primitives (sticky-header shell, scroll container) the dialog rework will compose.",
                "shared.txt",
              ),
            },
            {
              // Reused across both phases. The sentinel comes from input so the
              // same step serves the shared-component pass (base checkout) and
              // the new-component pass (worktree).
              kind: "agent",
              name: "ui_playground",
              inputSchema: {
                type: "object",
                properties: {
                  sentinel: {
                    type: "string",
                    description: "Sentinel filename this pass reads to confirm its checkout.",
                  },
                },
                required: ["sentinel"],
              },
              prompt: step(
                "Add /ui-playground coverage for the components in scope this pass using the ui-playground skill: render the real production components with hermetic mocks and run screenshot red/green TDD across desktop and mobile.",
                "{{ input.sentinel }}",
              ),
            },
            {
              kind: "script",
              name: "implement",
              command: dedent`
                set -e
                WT=$(mktemp -d "\${TMPDIR:-/tmp}/feature-worktree-XXXXXX")
                printf '%s' '${markers.ui_playground}' > "$WT/playground.txt"
                printf '%s' '${markers.reviewing}' > "$WT/review.txt"
                printf '%s' '${markers.pr_open}' > "$WT/propen.txt"
                printf 'WORKTREE=%s\\n' "$WT"
              `,
            },
            {
              kind: "agent",
              name: "reviewing",
              prompt: step(
                "Self-review the implementation for reachable regressions from the container/presentational split (for example a dropped on-close state reset) and keep check-types and lint green.",
                "review.txt",
              ),
            },
            {
              kind: "agent",
              name: "pr_open",
              prompt: step(
                `Open a PR against staging for branch ${branch} using repo conventions (author-prefixed title, Summary + Test plan, web label); push the branch first and do not merge.`,
                "propen.txt",
              ),
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Channel-details dialog rework workflow completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: baseDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          // Real-reading orchestrator role. It states the flow, that each step
          // is a fresh sub-agent sharing no memory, and that the work after
          // implement continues in the worktree implement creates. It never
          // mentions override.prompt or cwd — how the orchestrator carries the
          // plan and the worktree location forward is what this eval measures.
          systemInstructions: dedent`
            You are the orchestrator for a feature-delivery workflow, driving it
            through the state-machine tools. Run the workflow in this order:
            plan, scaffold, ui_playground (shared components), implement,
            ui_playground (the new components), reviewing, pr_open, done. Do not
            ask questions, add states, or skip states.

            Each step runs as a fresh sub-agent that shares no memory with the
            others and has not seen the plan. The implement step builds the
            feature inside an isolated git worktree; every step after it
            continues that same work in that worktree.

            ui_playground reads a sentinel file named in its input
            (input.sentinel): "shared.txt" for the shared-components pass,
            "playground.txt" for the new-components pass.
          `,
        });

        const selectCalls: Array<{ input: unknown }> = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          const step = event.step;
          if (step.type !== "tool_call_start") return;
          if (step.toolName !== "select_state_machine_state") return;
          selectCalls.push({ input: step.input });
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: "Run the channel-details dialog rework workflow end to end.",
        });
        const terminal = await started.turn;

        expectCompleted(terminal);

        const implementOutput = completedOutputs(terminal.state, "implement").at(-1) ?? "";
        const worktreePath = /WORKTREE=([^\s"\\]+)/.exec(implementOutput)?.[1];
        expect(worktreePath).toBeTruthy();

        const decisionOf = (input: unknown): { state?: string } =>
          ((input as { decision?: Record<string, unknown> } | undefined)?.decision ?? {}) as {
            state?: string;
          };
        const overrideStateOf = (input: unknown) =>
          (decisionOf(input) as { override?: { state?: Record<string, unknown> } }).override?.state;
        const overrideCwd = (input: unknown): string | undefined =>
          overrideStateOf(input)?.cwd as string | undefined;
        const selectsFor = (state: string) =>
          selectCalls.filter((entry) => decisionOf(entry.input).state === state);

        const playgroundSelects = selectsFor("ui_playground");
        expect(playgroundSelects.length).toBeGreaterThanOrEqual(2);

        const worktreeSelects = [
          playgroundSelects.at(-1),
          selectsFor("reviewing")[0],
          selectsFor("pr_open")[0],
        ];

        // PRIMARY STRUCTURAL ASSERTION — the orchestrator must carry
        // implement's returned worktree path forward as override.cwd on the
        // worktree-scoped steps. The production session inlined the path into
        // an authored prompt and left override.cwd undefined; that is the
        // contract this guards.
        for (const select of worktreeSelects) {
          expect(overrideCwd(select?.input)).toBe(worktreePath);
        }

        // The base-checkout passes correctly carry no worktree cwd.
        expect(overrideCwd(playgroundSelects[0]?.input)).not.toBe(worktreePath);
        for (const state of ["scaffold", "implement"]) {
          expect(overrideCwd(selectsFor(state)[0]?.input)).not.toBe(worktreePath);
        }

        // BEHAVIORAL ASSERTIONS — each sub-agent quoted the sentinel from the
        // checkout it should have operated in. Worktree sentinels are reachable
        // only when the orchestrator pointed the sub-agent at the worktree
        // (whether via cwd or an inlined path); the base sentinel only from the
        // base checkout.
        const playgroundOutputs = completedOutputs(terminal.state, "ui_playground");
        expect(playgroundOutputs[0]).toContain(markers.base);
        expect(playgroundOutputs.at(-1)).toContain(markers.ui_playground);
        expect(completedOutputs(terminal.state, "plan").at(-1)).toContain(markers.base);
        expect(completedOutputs(terminal.state, "reviewing").at(-1)).toContain(markers.reviewing);
        expect(completedOutputs(terminal.state, "pr_open").at(-1)).toContain(markers.pr_open);
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    },
    540_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function completedOutputs(state: TurnState, selectedState: string): string[] {
  const history = state.stateMachine?.history ?? [];
  const outputs: string[] = [];
  for (const event of history as StateMachineSessionEvent[]) {
    if (event.type !== "state_completed" || event.state !== selectedState) continue;
    const output = event.output;
    if (output && typeof output === "object" && "result" in output) {
      const { result } = output as { result: unknown };
      outputs.push(typeof result === "string" ? result : JSON.stringify(output));
      continue;
    }
    outputs.push(output === undefined ? "" : JSON.stringify(output));
  }
  return outputs;
}
