import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnMode, TurnState } from "../types/protocol.js";

function currentDateSystemPrompt(): string {
  // Day-level resolution keeps the prompt stable for the whole UTC day so prompt
  // caching is not invalidated on every turn. Agents that need finer-grained
  // time should shell out via bash (e.g. `date`).
  const today = new Date().toISOString().slice(0, 10);
  return dedent`
    <current_date>
    Today's date (UTC): ${today}. Resolution is intentionally limited to the day to preserve prompt caching. If you need finer-grained time, run \`date\` via bash.
    </current_date>
  `;
}

const TOOL_EXECUTION_SYSTEM_PROMPT = dedent`
  <use_parallel_tool_calls>
  For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like \`ls\` or \`list_dir\`, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.
  </use_parallel_tool_calls>
`;

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

  // State execution happens after select_state_machine_state terminates the
  // parent agent turn, so later progress questions must inspect runner-owned
  // state instead of relying on the parent transcript.
  return [
    "Route durable business-process work through state-machine tools whenever possible.",
    "If the request is simple or unrelated, answer normally without calling a turn-runner control tool.",
    "After you select a state-machine state, the runner executes that state outside your current assistant message and may later sleep, wake, or continue in the background.",
    "State prompts and script commands may use template strings like {{ input.email }}. Add inputSchema to states that need template input, and pass matching input when selecting that state.",
    'Poll states run recurring script checks and must set intervalMs. Timer states are separate: use kind "timer" with wakeAt to pause until one absolute Unix epoch millisecond timestamp. Poll states fail the state machine when timeoutMs is exceeded.',
    "Use allowedSkills on agent states only when that sub-agent should receive a restricted skill set.",
    'When resuming after an interruption, an agent ask, or uncertainty about progress, call get_current_state_machine_state before selecting the next state. Also call it before answering user questions about current state-machine progress, background work, poll/wake status, what has already happened, or why the session is waiting. If currentState is "interrupted", use the history to identify the interrupted state and rerun it when appropriate.',
    "When the user changes direction during state-machine work, select the same state again with updated input or select a different state. Selecting a state while another state is running replaces the active state work.",
    constraint,
    definitionPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createBaseSystemPrompt(config: TurnRunnerConfig, skills: readonly Skill[]): string {
  return [
    config.systemInstructions,
    currentDateSystemPrompt(),
    TOOL_EXECUTION_SYSTEM_PROMPT,
    createSkillsSystemPrompt(skills),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createSkillsSystemPrompt(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  return dedent`
    Available skills (metadata only — call the \`read_skill\` tool with the skill name to load full instructions on demand):
    ${toXML({
      skills: skills.map((skill) => ({
        skill: { _attrs: { name: skill.name }, description: skill.description },
      })),
    })}
  `;
}
