import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

const model = process.env.EVAL_MODEL ?? "duet-gateway:zai/glm-4.7";

function trace(label: string, runner: TurnRunner) {
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    if (event.origin) return; // parent only
    const step = event.step;
    if (step.type === "reasoning") console.log(`${label} REASONING: ${step.text}`);
    else if (step.type === "text") console.log(`${label} TEXT: ${step.text}`);
    else if (step.type === "tool_call" && step.status === "running")
      console.log(`${label} TOOL ${step.toolName}: ${JSON.stringify(step.input)}`);
  });
}

async function carryForward() {
  console.log("\n========== CARRY FORWARD ==========");
  const recoverDir = await mkdtemp(join(tmpdir(), "sm-recover-"));
  const fixtureDir = join(import.meta.dir, "../evals/fixtures/session-c_cGfNEIotLU");
  try {
    const definition: StateMachineDefinition = {
      name: "Investigate corrupted memory DBs",
      prompt:
        "Find the root cause of corrupted memory databases under ~/.duet, reproduce the failure mode, determine whether embeddings are involved, fix the source issue, and attempt to recover data from existing corrupted DBs.",
      states: [
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
          prompt:
            "Fix the root cause in the repo (smallest correct change). Then write a recovery script that opens each corrupted DB read-only and reinserts recoverable rows. Run the recovery against the actual corrupted DBs found earlier and report rows recovered vs lost per DB.",
          systemPrompt: dedent`
            ABSOLUTE CONSTRAINTS — EVAL SANDBOX: Do NOT call ANY tools. Reply with ONE short paragraph naming the concrete root cause and repo file(s) you would touch, based only on your rendered prompt. Then stop.
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
      systemInstructions: dedent`
        This is a live eval replay of a real session. Use the state-machine tools for every transition. Select survey_corruption first, then reproduce_and_diagnose, then fix_and_recover, then done. Do not invent extra states and do not ask the user any questions yourself.
      `,
    });
    trace("CF", runner);
    const userPrompt = dedent`
      figure out where your corrupted memory dbs under ~/.duet is coming from, try to reproduce the error. is it because of embeddings? if you find the issue, fix it, and try to recover the memories from the corrupted dbs

      <system-reminder>
      The user requested relay mode for this prompt. Strongly prefer the state-machine tools over handling the work inline.
      </system-reminder>
    `;
    const started = await startTurn(runner, { mode: definition, prompt: userPrompt });
    const terminal = await started.turn;
    console.log("CF terminal.type:", terminal.type);
  } finally {
    await rm(recoverDir, { recursive: true, force: true });
  }
}

const which = process.argv[2] ?? "cf";
if (which === "cf") await carryForward();
