import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type { HarnessConfig } from "../types/config.js";
import type { HarnessMode, HarnessRun } from "../types/protocol.js";
import type { StateMachineAgentState, StateMachineRun } from "../types/state-machine.js";
import { readSkillInstructions } from "./skills.js";

const STATE_AGENT_HISTORY_CHAR_LIMIT = 12_000;

export function createSystemPromptWithAppendedLayers(input: {
  config: HarnessConfig;
  skills: readonly Skill[];
  append: Array<string | undefined>;
}): string {
  return [createBaseSystemPrompt(input.config, input.skills), ...input.append]
    .filter(Boolean)
    .join("\n\n");
}

export function createStateMachineSystemPromptLayer(input: {
  mode: HarnessMode;
  run?: HarnessRun;
}): string {
  const constraint =
    input.mode === "auto"
      ? "You may create new state-machine definitions whenever durable lifecycle work appears."
      : "You must stay constrained to the explicit state-machine definition unless no state fits.";
  const definition =
    typeof input.mode === "object" ? input.mode : input.run?.stateMachine?.definition;
  const definitionPrompt = definition
    ? dedent`
        Explicit state-machine definition:

        ${JSON.stringify(definition, null, 2)}

        Only select states by name from this definition. Do not invent state names.
      `
    : undefined;

  return [
    "Route durable business-process work through state-machine tools whenever possible.",
    "If the request is simple or unrelated, answer normally without calling a harness-control tool.",
    constraint,
    definitionPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createStateAgentSystemPromptLayer(input: {
  run: HarnessRun;
  state: StateMachineAgentState;
}): string | undefined {
  const stateMachine = input.run.stateMachine;
  if (!stateMachine) return undefined;

  return dedent`
    You are executing the "${input.state.name}" state in a state machine.

    State prompt:
    ${input.state.prompt}

    State-machine context:
    ${JSON.stringify(
      {
        originalPrompt: stateMachine.prompt,
        state: stateMachine.state,
        definition:
          input.state.contextScope === "state_machine" ? stateMachine.definition : undefined,
      },
      null,
      2,
    )}
  `;
}

export function createStateAgentPrompt(input: {
  run: HarnessRun;
  state: StateMachineAgentState;
}): string {
  const stateMachine = input.run.stateMachine;
  if (!stateMachine) return input.state.prompt;

  const history = createBoundedStateMachineHistory(stateMachine.history);
  return [
    input.state.prompt,
    "Use this bounded state-machine history as recent context for this state:",
    JSON.stringify(history, null, 2),
  ].join("\n\n");
}

function createBaseSystemPrompt(config: HarnessConfig, skills: readonly Skill[]): string {
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

function createBoundedStateMachineHistory(history: StateMachineRun["history"]): {
  omitted: number;
  events: StateMachineRun["history"];
} {
  const events: StateMachineRun["history"] = [];
  let size = 0;

  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index];
    const eventSize = JSON.stringify(event).length;
    if (events.length > 0 && size + eventSize > STATE_AGENT_HISTORY_CHAR_LIMIT) {
      return { omitted: index + 1, events };
    }
    events.unshift(event);
    size += eventSize;
  }

  return { omitted: 0, events };
}
