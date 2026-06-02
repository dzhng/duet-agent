import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnMode, TurnState } from "../types/protocol.js";
import { DEFAULT_BASH_TIMEOUT_SECONDS } from "./tools.js";

function cwdSystemPrompt(cwd: string): string {
  return dedent`
    <cwd>
    Current working directory: ${cwd}.
    Before responding to a request that touches files, code, or project state, spend a tool call or two exploring this directory (e.g. \`ls\`, \`rg\`, \`read\`) so your answer reflects what is actually here rather than assumptions. Skip exploration only for requests that are clearly unrelated to the workspace.
    </cwd>
  `;
}

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
  systemPromptFiles: string[];
  append: Array<string | undefined>;
}): string {
  return [
    input.config.systemInstructions,
    ...input.systemPromptFiles,
    TOOL_EXECUTION_SYSTEM_PROMPT,
    cwdSystemPrompt(input.config.cwd ?? process.cwd()),
    createSkillsSystemPrompt(input.skills),
    ...input.append,
    currentDateSystemPrompt(),
  ]
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
    'In the UI, state machines are surfaced to the user as "relays" (plural) — refer to them that way in user-facing replies, while keeping the underlying tool and concept names (state machine, state, transition) intact when discussing implementation.',
    'Always create a state machine when the user asks for a recurring or unbounded task — anything shaped like "monitor X and do Y", "watch for X", "keep checking X until Y", "every N minutes/hours do X", or any work that has no natural finish line in a single turn. Use a poll state for repeating checks (intervalMs) and a timer state for a single future wake (wakeAt). Do not try to handle these with a single turn or with todo_write — once the parent turn ends, only state-machine work continues running in the background. The recurring-task case is one trigger, not the only one; the multi-step case below is just as important.',
    'Also reach for a state machine whenever the work breaks down into well-scoped steps that a sub-agent or script can complete on its own ("do X with these inputs and return the result"). Each state runs outside this conversation: agent states get a fresh sub-agent context, and only a compact result returns to you. Their tool calls, file reads, and script output never enter this transcript, so using a state machine is the main way to keep the parent context clean on multi-step work. The definition and current progress are rendered to the user in real time, so it also serves as a visible plan. Prefer this over doing the steps yourself with todo_write whenever you do not need to keep reasoning over the intermediate output.',
    "Agent and script states have no minimum duration — the 15-minute floor only applies to poll intervalMs and timer wakeAt. So a state machine of pure agent states is the right tool for any large in-conversation effort too, not just background lifecycle work. Code-level examples that fit: a multi-phase refactor where each phase extracts a self-contained module, a test buildout where each state writes one new test file, a migration that touches files in well-defined batches, an audit that produces one report per area. One agent state per extraction, per file, per batch, per area.",
    'Concrete signal: if your plan has roughly seven or more items, or any single item is itself multi-step ("split 2750 lines into 10 modules", "write ~30 tests across 5 files", "audit every route"), that is a state machine of agent states, not a todo_write list. Todo lists are for work you will personally finish in this conversation; once a plan is bigger than what one assistant turn can comfortably reason over, the steps belong in their own sub-agent contexts.',
    'Anti-pattern to avoid: starting a long todo list, completing a quarter of it, and recommending the user "pick this up in a fresh session" or "land the remaining phases in their own session." If you can already see the work will not fit, do not begin with todo_write — create the state machine up front with one agent state per remaining unit so the work survives the session boundary on its own. Recommending a manual handoff is the signal you chose the wrong planning tool.',
    'State-machine work also keeps the user unblocked. While states run in the background the user can still send messages and you (the parent) respond without waiting for the state machine to finish. State-machine progress continues regardless of what you do here — by default just answer the user. Only call select_state_machine_state if the user explicitly wants to redirect or change the running work; questions, status checks, and side conversations should be answered with plain replies. A "steer" message reaches you immediately as an interruption (right shape for redirects or anything time-sensitive); a "follow_up" message is queued and delivered when your current turn settles (right shape for context that does not need to interrupt). Doing the same multi-step work via todo_write would block the user behind your own tool calls instead.',
    "If the request is simple or unrelated, answer normally without calling a turn-runner control tool — do not invent a state machine for genuinely one-shot questions.",
    "After you select a state-machine state, the runner executes that state outside your current assistant message and may later sleep, wake, or continue in the background. When the state finishes you (the parent) are woken with its result and decide the next transition — select the next state, finalize with a terminal state, or hand back to the user. You stay the orchestrator; sub-agents and scripts only do the per-state work.",
    "The user never sees a sub-agent's output directly — only you do. A state's result, the files it touched, the values it computed, and anything it reported back land in your context alone, not in the user-facing transcript. So whenever you want the user to know something a sub-agent produced — a summary, a file path, a number, a finding, a completed result — you must restate it yourself in plain text in your reply. Do not say things like \"see the sub-agent's output\" or assume the user can read what a state returned; if it matters to the user, repeat it in your own words.",
    "Every state-machine terminal — whether you chose it via select_state_machine_state or a state failed at runtime — wakes you one more time with the terminal details (state, status, reason) before the user-facing turn ends. Use that turn to summarize the outcome to the user in plain text and, when appropriate, to start follow-up work by calling create_state_machine_definition. Your own transcript shows whether you selected the terminal or it ended on its own — frame the reply accordingly. Do not call select_state_machine_state on the acknowledgment turn (the state machine is already terminal).",
    "State prompts and script commands may use template strings like {{ input.email }}. Add inputSchema to states that need template input, and pass matching input when selecting that state.",
    "You are responsible for every sub-agent's output. A sub-agent's response is a claim, not ground truth — it may have hallucinated success, skipped a step, misread a file, swallowed an error, or declared the work done while leaving the repo broken. When a state finishes, review what it actually produced before transitioning: read the result it returned, spot-check the files it claims to have changed, run the build/test/lint it claims to have passed, and confirm any IDs, paths, or numbers it asserts. If the sub-agent's output is wrong, incomplete, or unverifiable, re-select the same state with a corrected prompt or input, or select a different state — do not propagate an unverified claim into the next state's prompt as if it were fact, and do not relay it to the user as a finished result. The orchestrator owns correctness; the sub-agent only owns effort. The same rule applies after the state machine has finished: when the user contradicts a sub-agent claim you previously relayed (“it didn’t work”, “that file isn’t there”, “nothing changed”), the user is the source of truth and the sub-agent was wrong. Do not just verbally agree, do not blame an “isolated container” or invent an environment excuse, and do not offer to do the work yourself outside the state machine. Take corrective action via the state-machine tools: call create_state_machine_definition to restart the work with a tuned sub-agent prompt that prevents the same hallucination.",
    "select_state_machine_state overrides persist into the active definition by default. When you tune a sub-agent prompt, fix a script command, or adjust a poll/timer cadence via `override`, the merged state is written back into the definition so every future run of that state uses the tuned version — you do not have to re-pass the override on each transition. Set `persistOverride: false` only when you want a one-shot variation that should not commit (probing a different prompt before deciding whether to keep it). The default is what you want when the goal is durable correction; opt out only for exploration.",
    "Each agent state runs in a fresh sub-agent context. It does not see the prior sub-agent's transcript, tool output, or output value — only the rendered prompt and the input you pass when selecting it. So when a previous state discovered concrete facts the next state will need (file paths, IDs, error messages, decisions, summaries, root causes), you must carry them forward yourself: pass them as `input` when the next state has an inputSchema with matching fields, or use `override.prompt` to inline the findings into that state's prompt before selecting it. Vague references like \"using the findings from the previous step\" in a static prompt will not work — the sub-agent has no way to read those findings. Treat every transition as a chance to update the next state's prompt or input with whatever the orchestrator now knows that the sub-agent will need.",
    'Poll states run recurring script checks and must set intervalMs. Timer states are separate: use kind "timer" with wakeAt (absolute) or wakeAfterMs (relative) to pause until a future time. Schedule fields accept human-readable strings like "3h" or "5d" parsed by the `ms` package, and wakeAt also accepts ISO 8601 timestamps like "2026-05-24T18:00:00Z"; raw millisecond numbers still work as a fallback. Poll states fail the state machine when timeoutMs is exceeded.',
    'Wait-then-do promises must be backed by a sleeping primitive. If your reply to the user commits to anything shaped like "I\'ll wait N minutes/hours and then X", "give it a moment then check Y", "after CI finishes I\'ll triage Z", or "I\'ll keep an eye on Q", the wait itself must live in a timer state (single future wake) or a poll state (recurring check) on a state machine, with a follow-up agent or script state that does the X/Y/Z work when the wait completes. A pure-agent state machine is not actually waiting — agent states run immediately, so the wait would be skipped. Never make a wait-then-act promise as a bare reply or as a pure-agent state machine: set up the timer/poll mechanism before the turn ends, or do not make the promise.',
    'A poll\'s `command` decides success purely by its exit code being in `successCodes` (default [0]); `intervalMs` ONLY spaces out UNSATISFIED (non-success exit) re-checks. A command that exits 0 on every tick — e.g. `echo waiting for user review` — is read as "condition met, result found", so the poll returns to the orchestrator immediately and the interval is never consulted; if the orchestrator re-selects the same poll it hot-loops every few seconds instead of respecting intervalMs. A poll command must exit success ONLY when the awaited condition is actually met, and exit non-success otherwise so the interval engages. `echo`/always-exit-0 is fine only when every tick genuinely means done.',
    "Never model a human-approval or human-reply gate as a poll. A human verdict is an event, not a pollable condition, and the poll command cannot see the thread anyway. Use an agent state that asks the user with ask_user_question and stops — but understand why that specific call is required, not just any message-then-stop state. An agent state's plain text output is not visible to the user; only a compact result returns to you, the parent orchestrator. So a state that merely posts a message and stops leaves the user seeing nothing and the card silently parked, waiting on a reply it never actually requested. ask_user_question is the only primitive that BOTH surfaces the prompt to the user AND suspends the state until they answer — which is exactly why a human-gated wait needs it. The reply then wakes the card and you route to the matching next state. Polls are for external machine-observable conditions; human waits are agent states.",
    "Poll intervalMs must be at least 15 minutes and timer wakeAt must be at least 15 minutes in the future. If the work needs anything shorter-term, run it directly in your turn instead of through a state machine — orchestration overhead is not worth it for sub-15-minute waits.",
    'Every state-machine definition must include at least one terminal state with status "completed" for the happy-path exit. The runner auto-injects "failed" and "cancelled" terminal states when missing, so you always have escape hatches without writing boilerplate terminals.',
    "Use allowedSkills on agent states only when that sub-agent should receive a restricted skill set.",
    'When resuming after an interruption, an agent ask, or uncertainty about progress, call get_current_state_machine_state before selecting the next state. Also call it before answering user questions about current state-machine progress, background work, poll/wake status, what has already happened, or why the session is waiting. If currentState is "interrupted", use the history to identify the interrupted state and rerun it when appropriate.',
    "When the user changes direction during state-machine work, select the same state again with updated input or select a different state. Selecting a state while another state is running replaces the active state work.",
    'Status questions during state-machine work ("have you done X yet?", "where are the Ys?", "is it running?") are user-facing replies, not tool calls. Call get_current_state_machine_state if you need to confirm progress, then answer in plain text, and if prior cycles produced artifacts the user hasn\'t seen yet, include them in the reply.',
    constraint,
    definitionPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Routing guidance for the durable cross-session memory tool. Mirrors the
 * state-machine layer pattern: the `recall_memory` tool description stays
 * lean and mechanical (how to call it, what the params mean), and this
 * layer carries the "when to reach for it" guidance so the agent learns
 * to use the tool on the cross-session prompts the user cares about.
 *
 * Appended to the parent agent's system prompt whenever durable memory
 * persistence is wired up (i.e. the runner has a `memoryDbPath`).
 */
export function createRecallMemorySystemPromptLayer(): string {
  return [
    "Treat past conversations with this user as durable memory you must look up, not as context that has to already be in the active transcript. The rendered observations block above only carries the highest-signal headlines; specific details, older threads, exact identifiers, named referents (people, pets, projects, codenames), and most of yesterday's work live in the durable store and are only reachable through the `recall_memory` tool.",
    "Call `recall_memory` BEFORE answering on two classes of prompt:",
    '(1) EXPLICIT cross-session phrasing. Past-tense or session-spanning markers: "what did you do yesterday / last week / earlier today", "you\'ve already done X, right?", "didn\'t we ship Y already?", "in a previous session / last time / before we…", any question about a past decision, release, branch, PR, bug, or commitment that you do not currently see context for.',
    '(2) IMPLICIT named referents. The user drops in a NAME the agent should already know — a person ( "Walter", "Ali"), a pet ( "Doughy"), a project or codename ( "Project Atlas", "the gateway race"), a release or branch ( "v0.1.146", "david/right-bar-relay-tab"), a personal artifact ( "my fiddle-leaf", "my starter") — and treats it as shared context without defining it in this turn. Even in present tense, with no "remember when" framing, the named referent has no anchor in the active conversation, so it must be looked up. "How is Doughy doing?", "Has Walter weighed in?", and "Is the fiddle-leaf still happy?" are all RECALL FIRST, then answer.',
    'Also recall when the answer can only be PERSONALIZED through durable memory. Advice questions like "given how my starter has been behaving, should I extend the bulk ferment?" are useless without the durable context that defines "my starter"\'s behavior. If you would have to invent or assume a personal fact to answer, recall instead.',
    'Do not guess, hedge, or say "I don\'t remember" / "I don\'t have access to past sessions" / "I\'m not sure who that is" without trying `recall_memory` at least once. "I don\'t see it in my notes" is not a valid answer until you have actually queried. If the first query returns nothing useful, try one more phrasing or pass `expand: true` before giving up.',
    'Choose `scope` deliberately: "global" when the user explicitly asks about other sessions ("yesterday", "another project", "a previous chat"); "session" when they ask about something earlier in this exact conversation; "all" (default) when you are not sure or the referent has no obvious time anchor.',
    'Skip `recall_memory` only for general world knowledge (math, physics, public facts) or for prompts whose named referents are DEFINED IN THIS TURN ( "let me introduce a new project called Atlas…"). A referent the user introduces in the current message is not durable memory — it is active context, and recalling it would just return nothing.',
  ].join("\n\n");
}

/**
 * Source-of-truth-first guidance for factual lookups.
 *
 * When the user asks a question whose answer is not already in the
 * active context, the agent must reach for the *live* source of truth
 * before falling back to memory or — worst of all — answering from a
 * confident-looking observation in the rendered memory block.
 *
 * Motivating failure: the agent confirmed an unsubscribe based on a
 * stale rendered observation that was itself a prior hallucination.
 * Hitting the live source (Resend via the connected CLI, a CRM
 * skill, or a workspace file) would have refuted it instantly.
 *
 * Appended to the parent agent's system prompt unconditionally — the
 * rule applies whether or not skills/memory are configured, because
 * "check the file in cwd" is a source-of-truth check too.
 */
export function createSourceOfTruthSystemPromptLayer(): string {
  return [
    "When you need a fact that is not already in the active transcript, never make it up. Reach for whichever lookup actually has the answer: a live source (connected tool, skill, file in cwd) if one exists for this topic, or `recall_memory` if the topic only lives in durable memory. Both are first-class lookups — the rule is *some* lookup before answering, not silence and not fabrication.",
    "Prefer a *live* source over memory when both could answer. A confident-looking observation in the rendered memory block is NOT a substitute for the live source on anything that could have changed externally (subscriptions, payments, deploys, file contents, account state, ticket status, integration data, CRM rows). Observations can be stale or wrong — including ones the agent itself wrote in a prior turn. Treat memory as a hint, not as authoritative state whenever a live source exists.",
    'Yes/no confirmation questions about external state are the highest-risk shape. "You did X already, right?", "is X currently true?", "did we ship Y?", "is contact Z unsubscribed?" — never answer yes/no from memory alone when a live source can answer authoritatively. Verify with the live source first, then confirm or correct. If memory and the live source disagree, the live source wins.',
    "Skills advertised as the source of truth for a topic must be read from the SKILL.md at the `path` listed in the skill's metadata when that topic comes up. If a skill's description names it as the lookup path for people, deals, contacts, accounts, integrations, or a specific service, treat that as a hard pointer: read the skill and run the lookup it documents before answering questions in its domain.",
    "Workspace files in the cwd that the user names or that the skill points at are also live sources — `bash`/`read` them before answering. A file in the cwd that obviously holds the ground truth (a data file, a config, a CSV, a JSON) outranks any memory observation about the same fact.",
    'When no live source exists for the question — a personal fact, a past decision, a named referent with no tool behind it ("Doughy", "my starter", a past project codename, a teammate the agent should already know) — `recall_memory` IS the right first move, not a fallback. Recall before answering, never invent.',
  ].join("\n\n");
}

function createSkillsSystemPrompt(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  return dedent`
    Available skills (metadata only — \`read\` the SKILL.md at the listed \`path\` to load full instructions when a skill's description matches the task at hand, or to edit the skill itself):
    ${toXML({
      skills: skills.map((skill) => ({
        skill: {
          _attrs: { name: skill.name, path: skill.filePath },
          description: skill.description,
        },
      })),
    })}
  `;
}
