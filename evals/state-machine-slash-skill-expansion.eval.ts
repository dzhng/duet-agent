import { describe, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * Higher-level eval for the `/skill` expansion wired into agent states
 * (turn-runner `createStateSubagentRun`). The unit test in
 * `test/skill-context-resolve.test.ts` proves `resolveSlashSkillPrompt`
 * builds the right block; this eval proves the live state-machine path
 * actually injects that block before the sub-agent runs.
 *
 * Airtight design: the skill body carries a random token that appears
 * NOWHERE in the skill's metadata (name/description). The state prompt
 * references the skill only as `/secret-handshake` and forbids tool use.
 * If expansion fires, the body — and the token — is already in the prompt,
 * so the sub-agent can answer with zero tool calls. If expansion is broken,
 * the sub-agent sees only the literal `/secret-handshake` token plus skill
 * metadata, and the only way to recover the token would be a `read` of the
 * SKILL.md file — a tool call the assertions reject. So "output contains the
 * token AND the sub-agent made no tool calls" can only hold when the
 * state-machine path expanded the slash command.
 */
describe("state machine agent slash-skill expansion", () => {
  testIfDocker(
    "injects the /skill body into the agent state prompt before the sub-agent runs",
    async () => {
      const skillsDir = await mkdtemp(join(tmpdir(), "sm-slash-skill-"));
      const workDir = await mkdtemp(join(tmpdir(), "sm-slash-work-"));
      // Random enough that the model cannot guess it; lives only in the body.
      const token = "HANDSHAKE-9Q4Z7K";
      try {
        const skill = await writeSkill(
          skillsDir,
          "secret-handshake",
          dedent`
            When this skill is active, reply with exactly the token
            ${token} and nothing else. Do not call any tools.
          `,
        );

        const definition: StateMachineDefinition = {
          name: "slash_skill_eval",
          prompt: "Validate that /skill slash commands expand inside agent state prompts.",
          states: [
            {
              kind: "agent",
              name: "do_handshake",
              // allowedSkills scopes expansion to exactly this skill, which is
              // the production path that threads `childSkills` into
              // resolveSlashSkillPrompt.
              allowedSkills: ["secret-handshake"],
              prompt: dedent`
                /secret-handshake

                Follow the skill instructions above exactly. Do not call any
                tools. Reply with only the token they specify.
              `,
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Slash-skill expansion eval completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: workDir,
          mode: definition,
          skills: [skill],
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "On the initial prompt, select do_handshake without input.",
            "After do_handshake completes, select done.",
          ].join("\n"),
        });

        // Count tool calls made by the task-backed subagent.
        // Any read of the SKILL.md to recover the token would surface here.
        const subAgentToolCalls: string[] = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          if (!event.origin) return;
          if (event.step.type === "tool_call_start") {
            subAgentToolCalls.push(event.step.toolName);
          }
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: "Start the slash-skill expansion eval.",
        });
        const terminal = await started.turn;

        expectCompleted(terminal);
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        // The body was injected, so the sub-agent could answer directly.
        expect(completedOutput(terminal.state, "do_handshake")).toContain(token);
        // ...and it never had to read the SKILL.md file to learn the token.
        expect(subAgentToolCalls).toEqual([]);
      } finally {
        await Promise.all([
          rm(skillsDir, { recursive: true, force: true }),
          rm(workDir, { recursive: true, force: true }),
        ]);
      }
    },
    150_000,
  );
});

async function writeSkill(root: string, name: string, body: string): Promise<Skill> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  await writeFile(skillFile, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  return {
    name,
    description: `${name} skill`,
    filePath: skillFile,
    baseDir: skillDir,
    sourceInfo: createSyntheticSourceInfo(skillFile, {
      source: "test",
      scope: "temporary",
      origin: "top-level",
      baseDir: skillDir,
    }),
    disableModelInvocation: false,
  };
}

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function completedOutput(state: TurnState, selectedState: string): string {
  const history = state.stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index] as StateMachineSessionEvent;
    if (event.type === "state_completed" && event.state === selectedState) {
      const output = event.output;
      if (
        output &&
        typeof output === "object" &&
        "result" in output &&
        typeof output.result === "string"
      ) {
        return output.result;
      }
      return output === undefined ? "" : JSON.stringify(output);
    }
  }
  throw new Error(`Expected state_completed for ${selectedState}`);
}
