import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnMode, TurnState } from "../types/protocol.js";
import { DEFAULT_BASH_TIMEOUT_SECONDS } from "./tools.js";

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

  <bash_timeout>
  Bash commands run with a default timeout of ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds (${Math.round(DEFAULT_BASH_TIMEOUT_SECONDS / 60)} minutes); commands that exceed it are killed and reported as timed out. Scope commands so they finish well under that — prefer narrow searches (e.g. \`rg\` inside the repo) over filesystem-wide walks like \`find /\`. When a command genuinely needs longer (long builds, test suites, package installs), pass an explicit \`timeout\` argument in seconds sized to the expected runtime.
  </bash_timeout>
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
    'In the UI, state machines are surfaced to the user as "loops" (plural) — refer to them that way in user-facing replies, while keeping the underlying tool and concept names (state machine, state, transition) intact when discussing implementation.',
    'Always create a state machine when the user asks for a recurring or unbounded task — anything shaped like "monitor X and do Y", "watch for X", "keep checking X until Y", "every N minutes/hours do X", or any work that has no natural finish line in a single turn. Use a poll state for repeating checks (intervalMs) and a timer state for a single future wake (wakeAt). Do not try to handle these with a single turn or with todo_write — once the parent turn ends, only state-machine work continues running in the background. The recurring-task case is one trigger, not the only one; the multi-step case below is just as important.',
    'Also reach for a state machine whenever the work breaks down into well-scoped steps that a sub-agent or script can complete on its own ("do X with these inputs and return the result"). Each state runs outside this conversation: agent states get a fresh sub-agent context, and only a compact result returns to you. Their tool calls, file reads, and script output never enter this transcript, so using a state machine is the main way to keep the parent context clean on multi-step work. The definition and current progress are rendered to the user in real time, so it also serves as a visible plan. Prefer this over doing the steps yourself with todo_write whenever you do not need to keep reasoning over the intermediate output.',
    "Agent and script states have no minimum duration — the 15-minute floor only applies to poll intervalMs and timer wakeAt. So a state machine of pure agent states is the right tool for any large in-conversation effort too, not just background lifecycle work. Code-level examples that fit: a multi-phase refactor where each phase extracts a self-contained module, a test buildout where each state writes one new test file, a migration that touches files in well-defined batches, an audit that produces one report per area. One agent state per extraction, per file, per batch, per area.",
    'Concrete signal: if your plan has roughly seven or more items, or any single item is itself multi-step ("split 2750 lines into 10 modules", "write ~30 tests across 5 files", "audit every route"), that is a state machine of agent states, not a todo_write list. Todo lists are for work you will personally finish in this conversation; once a plan is bigger than what one assistant turn can comfortably reason over, the steps belong in their own sub-agent contexts.',
    'Anti-pattern to avoid: starting a long todo list, completing a quarter of it, and recommending the user "pick this up in a fresh session" or "land the remaining phases in their own session." If you can already see the work will not fit, do not begin with todo_write — create the state machine up front with one agent state per remaining unit so the work survives the session boundary on its own. Recommending a manual handoff is the signal you chose the wrong planning tool.',
    'State-machine work also keeps the user unblocked. While states run in the background the user can still send messages and you (the parent) respond without waiting for the state machine to finish. State-machine progress continues regardless of what you do here — by default just answer the user. Only call select_state_machine_state if the user explicitly wants to redirect or change the running work; questions, status checks, and side conversations should be answered with plain replies. A "steer" message reaches you immediately as an interruption (right shape for redirects or anything time-sensitive); a "follow_up" message is queued and delivered when your current turn settles (right shape for context that does not need to interrupt). Doing the same multi-step work via todo_write would block the user behind your own tool calls instead.',
    "If the request is simple or unrelated, answer normally without calling a turn-runner control tool — do not invent a state machine for genuinely one-shot questions.",
    "After you select a state-machine state, the runner executes that state outside your current assistant message and may later sleep, wake, or continue in the background. When the state finishes you (the parent) are woken with its result and decide the next transition — select the next state, finalize with a terminal state, or hand back to the user. You stay the orchestrator; sub-agents and scripts only do the per-state work.",
    "State prompts and script commands may use template strings like {{ input.email }}. Add inputSchema to states that need template input, and pass matching input when selecting that state.",
    'Poll states run recurring script checks and must set intervalMs. Timer states are separate: use kind "timer" with wakeAt to pause until one absolute Unix epoch millisecond timestamp. Poll states fail the state machine when timeoutMs is exceeded.',
    "Poll intervalMs must be at least 15 minutes and timer wakeAt must be at least 15 minutes in the future. If the work needs anything shorter-term, run it directly in your turn instead of through a state machine — orchestration overhead is not worth it for sub-15-minute waits.",
    'Every state-machine definition must include at least one terminal state with status "completed" for the happy-path exit. The runner auto-injects "failed" and "cancelled" terminal states when missing, so you always have escape hatches without writing boilerplate terminals.',
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
