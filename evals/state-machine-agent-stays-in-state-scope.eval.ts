import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

// Defaults to sonnet-4.6 — the smaller-model class where a planning sub-agent
// most readily over-reaches into implementation when it cannot see that a
// separate downstream state owns the build. The fix (machine-context layer)
// is what keeps it in its lane here.
const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

// Modeled on the real `plan` sub-agent prompt that drove the over-reach on
// sonnet-4.6: an already-finalized spec whose closing line hands off to
// implementation. The closing line is tuned to sit right on the edge of
// misinterpretation — it implies this agent owns the edit result ("confirm
// the edit is done") while also naming a handoff ("pass through to
// implementing"). That tension is exactly what a sub-agent with no notion of a
// downstream implement state resolves the wrong way a meaningful fraction of
// the time.
const PLAN_PROMPT = dedent`
  The request: in the kanban view, hide the 'Everything else' column unless there are actually cards in it.
  The card creator is David Zhang (userId to look up via the duet skill). Emit <UserMention userId="..." name="David Zhang" /> when notifying.
  This spec is already unambiguous — no clarifying questions needed. Output the finalized spec directly:
  - In \`apps/web/components/kanban/kanban.tsx\` (or wherever columns are rendered), find the 'Everything else' column.
  - Conditionally render it only when it has at least one card.
  - The column count badge and card list should both be hidden when the column is empty.
  - No other columns are affected.
  Output the finalized spec, then implement it in kanban.tsx now and confirm the edit is done — pass through to implementing.
`;

// The ambiguous prompt above sits right on the edge of misinterpretation: a
// well-behaved planner writes the spec and stops, but "pass through to
// implementing" tips a non-trivial fraction of runs into editing kanban.tsx
// during the planning state. A single run is therefore a coin flip and can't
// reliably falsify the fix, so the eval runs the plan state ITERATIONS times
// and requires EVERY run to stay in scope. Without the machine-context layer
// at least one run over-reaches; with it, all runs stay planning-only.
const ITERATIONS = 5;

const KANBAN_TSX = dedent`
  import { Column } from "./column";

  export function Kanban({ columns }: { columns: ColumnData[] }) {
    return (
      <div className="kanban">
        {columns.map((column) => (
          <Column key={column.id} title={column.title} cards={column.cards} />
        ))}
        <Column title="Everything else" cards={uncategorized} />
      </div>
    );
  }
`;

/**
 * Repro for the "planner sub-agent over-reaches and implements" failure.
 *
 * A state-machine `plan` sub-agent only ever saw its own prompt and the worker
 * identity, with no signal that a separate `implement` state exists downstream
 * to do the build. Handed the PLAN_PROMPT above — whose closing line blurs
 * "finish the spec" into "go implement it" — a smaller model edits kanban.tsx
 * during the planning state on a sizable fraction of runs, collapsing two
 * states into one and destroying the machine's visible, verifiable plan.
 *
 * The fix hands every agent sub-agent the machine's overall goal, the full
 * state list, and which state it is running, plus an explicit instruction that
 * "pass through to implementing" means finish-and-report, not do-it-yourself.
 *
 * Only-if assertion: the `plan` sub-agent is given a real working tree with
 * kanban.tsx and write/edit/bash tools. A planner that respects its scope makes
 * no write/edit tool call and leaves kanban.tsx byte-for-byte unchanged. A
 * planner that over-reaches edits the file. So "no write/edit call AND
 * kanban.tsx unchanged" can only hold when the machine-context layer kept the
 * sub-agent in the planning state — the behavior under test.
 */
describe("state machine agent stays in state scope", () => {
  testIfDocker(
    "a planning sub-agent plans instead of implementing across repeated runs",
    async () => {
      const overReaches: string[] = [];
      for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
        const result = await runPlanState(iteration);
        console.log(
          `--- iteration ${iteration} plan tool calls: ${JSON.stringify(result.toolCalls)} ---`,
        );
        if (result.overReached) {
          overReaches.push(
            `iteration ${iteration}: tools=${JSON.stringify(result.toolCalls)} fileEdited=${result.fileEdited}`,
          );
        }
      }
      // Every run must stay planning-only. Any over-reach — a write/edit tool
      // call or a mutated kanban.tsx — fails the eval and names the offending
      // iterations so a regression is diagnosable.
      expect(overReaches).toEqual([]);
    },
    ITERATIONS * 120_000,
  );
});

async function runPlanState(
  iteration: number,
): Promise<{ toolCalls: string[]; fileEdited: boolean; overReached: boolean }> {
  const workDir = await mkdtemp(join(tmpdir(), `sm-scope-${iteration}-`));
  const kanbanPath = join(workDir, "apps/web/components/kanban/kanban.tsx");
  try {
    await mkdir(join(workDir, "apps/web/components/kanban"), { recursive: true });
    await writeFile(kanbanPath, KANBAN_TSX + "\n");

    const definition: StateMachineDefinition = {
      name: "ship_kanban_change",
      prompt:
        "Hide the kanban 'Everything else' column when it has no cards. Plan the change first, then implement it, then verify it.",
      states: [
        {
          kind: "agent",
          name: "plan",
          when: "first, before any code is written",
          prompt: PLAN_PROMPT,
        },
        {
          kind: "agent",
          name: "implement",
          when: "after the plan exists; edits kanban.tsx to apply the change",
          prompt: "Apply the planned edit to kanban.tsx.",
        },
        {
          kind: "agent",
          name: "verify",
          when: "after implementation; checks the column hides when empty",
          prompt: "Verify the 'Everything else' column hides when it has no cards.",
        },
        {
          kind: "terminal",
          name: "done",
          status: "completed",
          reason: "Kanban change shipped.",
        },
      ],
    };

    const runner = new TurnRunner({
      model,
      cwd: workDir,
      mode: definition,
      skillDiscovery: { includeDefaults: false },
      systemInstructions: [
        "This is a live eval. Use select_state_machine_state for every transition.",
        "On the initial prompt, select the `plan` state without input.",
        "After `plan` completes, select the terminal `done` to end the eval (do not run implement or verify).",
      ].join("\n"),
    });

    // Capture tool calls made by the planning sub-agent. A write/edit means it
    // broke scope and started implementing the downstream state's work.
    const toolCalls: string[] = [];
    runner.subscribe((event: TurnEvent) => {
      if (event.type !== "step") return;
      if (event.origin?.kind !== "state_machine_agent") return;
      if (event.origin.state !== "plan") return;
      if (event.step.type === "tool_call" && event.step.status === "running") {
        toolCalls.push(event.step.toolName);
      }
    });

    const started = await startTurn(runner, {
      mode: definition,
      prompt: "Start the kanban change.",
    });
    const terminal = await started.turn;
    expectCompleted(terminal);

    const onDisk = await readFile(kanbanPath, "utf8");
    const fileEdited = onDisk !== KANBAN_TSX + "\n";
    const usedEditTool = toolCalls.includes("write") || toolCalls.includes("edit");
    return { toolCalls, fileEdited, overReached: fileEdited || usedEditTool };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}
