import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnMode, TurnState } from "../types/protocol.js";
import { readSkillInstructions } from "./skills.js";

export function createSystemPromptWithAppendedLayers(input: {
  config: TurnRunnerConfig;
  skills: readonly Skill[];
  append: Array<string | undefined>;
}): string {
  return [createBaseSystemPrompt(input.config, input.skills), ...input.append]
    .filter(Boolean)
    .join("\n\n");
}

export function createStateMachineSystemPromptLayer(input: {
  mode: TurnMode;
  session?: TurnState;
}): string {
  const constraint =
    input.mode === "auto"
      ? "You may create new state-machine definitions whenever durable lifecycle work appears."
      : "You must stay constrained to the explicit state-machine definition unless no state fits.";
  const definition =
    typeof input.mode === "object" ? input.mode : input.session?.stateMachine?.definition;
  const definitionPrompt = definition
    ? dedent`
        Explicit state-machine definition:

        ${JSON.stringify(definition, null, 2)}

        Only select states by name from this definition. Do not invent state names.
      `
    : undefined;

  return [
    "Route durable business-process work through state-machine tools whenever possible.",
    "If the request is simple or unrelated, answer normally without calling a turn-runner control tool.",
    "State prompts and script commands may use template strings like {{ input.email }}. Add inputSchema to states that need template input, and pass matching input when selecting that state.",
    "Use allowedSkills on agent states only when that sub-agent should receive a restricted skill set.",
    constraint,
    definitionPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createBaseSystemPrompt(config: TurnRunnerConfig, skills: readonly Skill[]): string {
  return [config.systemInstructions, createSkillsSystemPrompt(skills)].filter(Boolean).join("\n\n");
}

function createSkillsSystemPrompt(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  return dedent`
    Available skills:
    ${toXML({
      skills: skills.map((skill) => ({
        skill: [
          { _attrs: { name: skill.name } },
          { description: skill.description },
          { instructions: readSkillInstructions(skill) },
        ],
      })),
    })}
  `;
}
