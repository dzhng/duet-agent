import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const INTERRUPTED_STATE_MACHINE_STATE = "interrupted";

/**
 * Durable state-machine definitions and runtime state.
 *
 * A state machine models the high-level business process, not task execution.
 * There is one current business state at a time. The state-machine runner agent
 * sees the original prompt, current transition input, state history, and state
 * definitions, then decides which state should run next, whether the session should
 * wait, or whether a terminal state should finalize the state machine.
 *
 * If a state needs fan-out, parallelism, or task-level workflow execution, that
 * belongs inside an agent or script state. The state machine only tracks the
 * business-level state transition.
 * Do not hardcode integrations such as email, GitHub, Slack, Calendly, or
 * webhooks into the engine. Any external system with an API or CLI is a bash
 * script away, and this engine can accept a few minutes of polling latency
 * instead of requiring realtime responsiveness.
 *
 * Case 1: conference outreach state machine
 *
 * User provides an email address. Agent/script states can enrich the prospect,
 * research the company, draft/send outreach, then a poll state can check whether
 * the prospect has replied or whether the next follow-up date has arrived.
 *
 * The runner should:
 *
 * 1. Start a StateMachineSession from a StateMachineDefinition.
 * 2. Enter an agent state for enrichment/research and record the output in the
 *    session history so the state machine can resume without repeating research.
 * 3. Enter a send-email script state and record the sent message details.
 * 4. The runner can choose a poll state. The runner runs one poll attempt,
 *    emits a sleep event if nothing changed, and relies on the outer layer to
 *    wake it later. A poll attempt can run a script or prompt an agent, and
 *    should return structured data only when there is something for the state
 *    machine to do next, such as:
 *    - prospect replied
 *    - follow-up due
 *    - meeting scheduled
 *    - outreach window expired
 * 5. When polling returns a reply payload, resume the session and ask an
 *    agent to classify it: interested, negative, ad hoc question, neutral, or
 *    unclear.
 * 6. The runner chooses the appropriate next state based on that classification:
 *    - interested -> send Calendly / schedule-meeting state
 *    - ad hoc question -> answer question, then return to waiting
 *    - negative -> terminal state: prospect_not_interested
 *    - unclear -> ask a follow-up or wait for more context
 * 7. When polling returns follow-up_due, send a follow-up if the session
 *    has not exceeded the cadence limit. For example: every 4 days for one
 *    month.
 * 8. End in one of the named terminal states:
 *    - meeting_scheduled
 *    - prospect_not_interested
 *    - negative_response
 *    - no_response_after_followups
 *
 * The state-machine types should support this by representing:
 *
 * - durable session history
 * - agent/tool/script states whose outputs are available through state-machine history
 * - poll states, plus explicit waits for human input
 * - runner-agent decisions driven by full prompt, transition input, and history
 * - named terminal states richer than generic "completed" or "failed"
 *
 * Case 2: development state machine
 *
 * User provides a prompt. Agent/script states can create an isolated worktree,
 * run a dev agent, run a review agent, create a PR, poll until the PR is merged
 * or closed, then clean up the worktree.
 *
 * The runner should:
 *
 * 1. Start a StateMachineSession from the user's prompt.
 * 2. Execute a script/tool state that creates a worktree and records its path in
 *    state-machine history.
 * 3. Execute an agent state that implements the requested code change inside the
 *    worktree.
 * 4. Execute a review agent state. The review can either approve, request fixes,
 *    or block the state machine.
 * 5. If fixes are requested, choose the dev-agent state again with the review
 *    feedback as input. The session history should preserve both attempts.
 * 6. When approved, execute a PR creation state and record PR number/URL.
 * 7. Enter a poll state. Each poll attempt can use gh, git, or any other
 *    CLI/API wrapper to inspect the PR state and return:
 *    - merged -> continue to cleanup and terminal state: merged
 *    - closed -> continue to cleanup and terminal state: closed
 * 8. Execute cleanup using the recorded worktree path.
 *
 * The state-machine types should support this by representing:
 *
 * - a catalog of available business states
 * - retry/review loops without losing prior state history
 * - poll states that use sleep between attempts
 * - cleanup/finalizer states that run after terminal external outcomes
 * - terminal states such as merged, closed, failed_review, or cancelled
 *
 * In state-machine mode, the parent runner is still a normal pi agent with its
 * normal tools. The difference is prompting and routing: it should do as much
 * durable business-process work through the state machine as possible, while
 * still answering simple unrelated requests directly when that is the right
 * behavior. The parent runner dispatches the current state, records the
 * selected state's result, asks the runner agent what state should come next,
 * updates history, and emits protocol events.
 *
 * Agent states execute by running the runner in normal agent mode. The parent
 * runner is not a separate worker pool; the selected state owns execution, and
 * an agent state delegates that execution back to a turn-runner agent-mode turn.
 * This lets the same state machine start in the middle when the user's prompt
 * says prior work already happened, such as "I've already sent email, just wait
 * for response." The runner injects the original prompt and relevant history
 * automatically when constructing agent prompts; state definitions only describe
 * their own behavior. Human input is parent-owned: the machine parks without
 * executing work, and the parent asks any question needed to leave that park.
 * Polling remains explicit because the runner owns one poll attempt and emits
 * sleep until the next attempt.
 *
 * Example of templated script commands:
 *
 * The parent runner can pass transition input when selecting a state:
 *
 *   {
 *     kind: "script",
 *     inputSchema: {
 *       type: "object",
 *       properties: { branchName: { type: "string" } },
 *       required: ["branchName"]
 *     },
 *     command: "scripts/create-worktree.sh '{{ input.branchName }}'"
 *   }
 *
 * A later dev state or cleanup state can receive fresh input selected from
 * prior completion output:
 *
 *   {
 *     kind: "script",
 *     command: "rm -rf '{{ input.worktreePath }}'"
 *   }
 *
 * A PR poll state can check through any CLI/API wrapper without the state
 * machine engine knowing about GitHub:
 *
 *   {
 *     kind: "poll",
 *     command: "scripts/check-pr-finished.sh '{{ input.prUrl }}'",
 *     intervalMs: 300000
 *   }
 */

/** User-authored state machine template. Runtime progress lives in StateMachineSession. */
export interface StateMachineDefinition {
  /** Human-readable label for selection in CLIs/UIs. */
  name: string;
  /**
   * Routing guidance for the runner agent. This explains when this definition's
   * set of states applies; if the user's request does not match this prompt, the
   * selected state can be undefined and the runner can answer normally in agent mode.
   */
  prompt: string;
  /** Available states the runner agent can choose from, including terminal states. */
  states: StateMachineState[];
}

/**
 * Persisted execution state. The runner can stop after any state and later
 * continue from this session without redoing completed work.
 */
export interface StateMachineSession {
  /** Current active definition. Required for resuming and dispatching currentState. */
  definition: StateMachineDefinition;
  /** Original user request that started the state machine. */
  prompt: string;
  /**
   * Current business state, selected by the runner agent.
   *
   * The reserved value "interrupted" means runtime work was aborted before the
   * state could finish. It is not a user-authored state name; the previous
   * running state and its input remain available in history.
   */
  currentState?: string;
  /**
   * Input supplied by the parent runner when it selected the current state.
   * Persisted so sleeping scheduled states can resume with the same template values.
   */
  currentInput?: Record<string, unknown>;
  /**
   * Compact progress counters for status questions. This stays separate from
   * history so frequent poll sleeps do not spam the audit log.
   */
  progress?: StateMachineProgress;
  /** Append-only audit log used for debugging, replay, and persistence. */
  history: StateMachineSessionEvent[];
  /** Present only after a session reaches a named terminal state. */
  terminal?: StateMachineTerminalResult;
  /**
   * Set once the parent runner has run its acknowledgment turn for the
   * current `terminal`. The state-machine tools end the parent's
   * prompt loop with `terminate: true`, so a turn that drives the
   * state machine to a terminal status leaves the parent's transcript
   * without any natural acknowledgment of the outcome — the turn
   * runner closes that gap by running one final parent prompt as soon
   * as a terminal is recorded (see `runStateMachineTerminalAcknowledgment`
   * in turn-runner.ts).
   *
   * The flag is per-session: it prevents the same `session.terminal`
   * from being re-acknowledged if the parent re-routes back into the
   * turn loop during the acknowledgment pass. A new state machine
   * created during the acknowledgment turn lives on a fresh session
   * built by `createStateMachineSession` and gets its own
   * acknowledgment when it terminates.
   */
  terminalAcknowledged?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type StateMachineState =
  | StateMachineAgentState
  | StateMachineScriptState
  | StateMachinePollState
  | StateMachineTimerState
  | StateMachineParkState
  | StateMachineTerminalState;

export interface StateMachineProgress {
  /** Per-state counters keyed by state name for compact status reporting. */
  states: Record<string, StateMachineStateProgress>;
}

export interface StateMachineStateProgress {
  /** State kind from the active definition when the progress entry was updated. */
  kind?: StateMachineState["kind"];
  /** Number of times the parent selected this state. */
  runs: number;
  /** Number of times this state emitted sleep while waiting for a later wake. */
  sleeps: number;
  /** Scheduled wake time from the latest sleep, cleared when the state runs again. */
  nextWakeAt?: number;
  /**
   * Timestamp of the latest `state_started` for this state. Mirrors what
   * `history` records so elapsed-time checks (e.g. poll `timeoutMs`)
   * keep working even after old `state_started` entries fall off the
   * capped history.
   */
  startedAt?: number;
}

export interface StateMachineBaseState {
  /** Name shown in status output and used by the runner when choosing a state. */
  name: string;
  /** Helps the runner agent understand when this state is appropriate. */
  when?: string;
  /**
   * Optional JSON Schema for the input the parent runner must provide when
   * selecting this state. The runner validates transition input before executing
   * the state and exposes it to prompt/script templates as `input`.
   */
  inputSchema?: Record<string, unknown>;
}

/** Runs an agent. The runner injects original prompt/history outside this state config. */
export interface StateMachineAgentState extends StateMachineBaseState {
  kind: "agent";
  /**
   * User prompt sent to the sub-agent. The runner renders this as a template
   * using the transition input provided when the parent runner selected this
   * state.
   */
  prompt: string;
  /**
   * Optional system prompt appended to the runner's base system prompt for this
   * sub-agent only. Use this for durable role or behavior instructions; dynamic
   * state input belongs in `prompt`.
   */
  systemPrompt?: string;
  /**
   * Optional skill allowlist for this sub-agent. When set, only these discovered
   * or explicitly configured skills are injected into the sub-agent system
   * prompt.
   */
  allowedSkills?: string[];
  /**
   * Working directory for this sub-agent's coding tools (bash, read, write,
   * edit). Defaults to the state-machine session cwd. Set this when an agent
   * state should operate on a different repository or subdirectory than the
   * parent runner.
   */
  cwd?: string;
  /**
   * Exact model for this sub-agent, as shorthand (e.g. "opus-4.7") or
   * provider:modelId. When unset the sub-agent inherits the parent runner's
   * model. Intentionally NOT exposed on create_state_machine_definition or on
   * select_state_machine_state's override: the orchestrating model does not
   * know the available model catalog, so it must not pick a model. This is set
   * by the user through the UI, which can present the real model list. An
   * unknown value fails at resolveModelName the same way a bad CLI --model
   * does.
   */
  model?: string;
  /**
   * Reasoning effort for this sub-agent. Same UI-only contract as `model`:
   * absent from the tool schemas so the orchestrating model cannot set it, and
   * written by the UI instead. Inherits the parent runner's thinking level when
   * unset.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Whether this sub-agent starts with a copy of the parent runner's
   * conversation context instead of a fresh, empty transcript.
   *
   * When `false` (the default, and the historical behavior), the sub-agent
   * starts clean: it sees only the `prompt` rendered for this state, the
   * worker-identity system-prompt layer, and the transition `input` you pass.
   * Use this for narrow, self-contained tasks where a crisp prompt carries
   * everything the sub-agent needs and prior context would distract or bias.
   *
   * When `true`, the runner seeds the sub-agent with a verbatim copy of the
   * parent runner's full context — the parent's system prompt AND its message
   * history — so the sub-agent inherits prior discussion, decisions,
   * constraints, and tool history. To keep this economical the fork preserves
   * the parent's exact cached prefix (same system prompt + same leading
   * messages), and everything state-specific — the worker-identity layer, the
   * per-state `systemPrompt`, and the state's own `prompt` — is delivered as a
   * new tail user turn, the only uncached part. Use this when the task depends
   * on prior thread decisions or user preferences that would be tedious or
   * lossy to restate in the state prompt, or when continuing a complex thread.
   *
   * The forked transcript is transient: it is not persisted into the
   * state-machine session history (only the state's compact final output is),
   * so forking does not bloat the durable session.
   */
  forkContext?: boolean;
}

/** Runs a shell command. This is the generic integration primitive. */
export interface StateMachineScriptState extends StateMachineBaseState {
  kind: "script";
  /**
   * Shell command used for integrations, setup, cleanup, and deterministic
   * checks. The runner renders this as a template using transition input; keep
   * state-machine definitions serializable instead of storing executable
   * functions here.
   */
  command: string;
  /** Working directory for the command. Defaults to the state-machine session cwd. */
  cwd?: string;
  /** Kills the command if it exceeds this runtime. */
  timeoutMs?: number;
  /** Exit codes treated as success. Defaults to [0]. */
  successCodes?: number[];
}

/** Performs one external check, then either records data or sleeps until the next attempt. */
export interface StateMachinePollState extends StateMachineBaseState {
  kind: "poll";
  /**
   * Recurring delay between external check attempts. Accepts either a
   * human-readable duration string parsed by the `ms` package (e.g. `"30s"`,
   * `"15m"`, `"3h"`, `"5d"`) or a raw number of milliseconds.
   */
  intervalMs: number | string;
  /** Maximum time the state machine can remain in this poll state before failing the session. */
  timeoutMs?: number;
  /**
   * Runs once per poll attempt. The script signals "found a result" by
   * exiting with a code in `successCodes`; any other exit code is treated
   * as "keep polling" and the runner sleeps for `intervalMs` before the
   * next attempt. Stdout is captured and surfaced as the state output
   * (and parsed as JSON when possible for convenience), but the parse
   * result does NOT affect whether the poll completes — only the exit
   * code does.
   */
  command: string;
  /** Working directory for the command. Defaults to the state-machine session cwd. */
  cwd?: string;
  /** Exit codes that mean this poll found a result. Defaults to [0]. */
  successCodes?: number[];
}

/** Sleeps until a future time, then lets the parent choose the next state. */
export interface StateMachineTimerState extends StateMachineBaseState {
  kind: "timer";
  /**
   * Absolute time when this timer state should complete. Accepts either an
   * ISO 8601 date string (e.g. `"2026-05-24T18:00:00Z"`) or a raw Unix-epoch
   * millisecond number. Mutually exclusive with `wakeAfterMs` — exactly one of
   * the two must be set.
   */
  wakeAt?: number | string;
  /**
   * Relative duration measured from the moment the parent selects this timer
   * state, after which the timer should complete. Accepts either a
   * human-readable duration string parsed by the `ms` package (e.g. `"3h"`,
   * `"5d"`) or a raw number of milliseconds. Useful when the wait length is
   * known up front but the absolute wake time is not (for example reusable
   * definitions, or transitions where the start time is decided by the parent
   * at selection time). Mutually exclusive with `wakeAt`.
   */
  wakeAfterMs?: number | string;
}

/** Holds the machine without execution or a scheduled wake while the parent drives. */
export interface StateMachineParkState extends StateMachineBaseState {
  kind: "park";
}

/** Finalizes the session when reached. Terminal outcomes are just state machine states. */
export interface StateMachineTerminalState extends StateMachineBaseState {
  kind: "terminal";
  /** Maps this named outcome to the session's lifecycle status. */
  status: "completed" | "failed" | "cancelled";
  /** Optional final explanation shown to users and recorded in history. */
  reason?: string;
}

export interface StateMachineTerminalResult {
  /**
   * Names the terminal state that finalized the session. For a runtime failure
   * this is the state that errored (the poll/agent/script state), not a
   * terminal state in the definition.
   */
  state: string;
  /**
   * The session's final lifecycle status. `completed`/`failed`/`cancelled` come
   * from a terminal state the agent deliberately selected. `error` is
   * runtime-only: it is never an authored terminal status (the agent cannot
   * select it) and is set solely by the runner when the machine crashes — a
   * poll timeout, an unknown/invalid selected state, an agent/script state
   * failure, the misconfigured-poll gate, or exhausted protocol-violation
   * retries. Only an `error` outcome fails the turn; the other three are
   * successful turn outcomes whose meaning lives in `state`/`reason`.
   */
  status: StateMachineTerminalState["status"] | "error";
  /** Optional final explanation, often generated by the runner. */
  reason?: string;
}

export type StateMachineSessionEvent =
  | { type: "state_machine_started"; timestamp: number }
  | { type: "runner_decided"; timestamp: number; decision: unknown }
  | {
      type: "state_started";
      timestamp: number;
      state: string;
      input?: Record<string, unknown>;
    }
  | { type: "state_completed"; timestamp: number; state: string; output?: unknown }
  | { type: "state_failed"; timestamp: number; state: string; error: string }
  | {
      type: "state_interrupted";
      timestamp: number;
      state: string;
      reason?: string;
      output?: { assistantText?: string } | { stdout: string; stderr: string };
    }
  | {
      // Emitted when select_state_machine_state persists an override into
      // the active definition (decision.persistOverride !== false). Captures
      // the merged state so anyone replaying history can see when and how
      // the definition drifted from its original create_state_machine_definition
      // shape.
      type: "state_definition_updated";
      timestamp: number;
      state: string;
      updatedState: StateMachineState;
    }
  | { type: "state_machine_completed"; timestamp: number; terminal: StateMachineTerminalResult }
  | {
      // Recorded when a finished session is resumed (see
      // recordStateMachineReactivated for when this is legal). `state` is the
      // resumed state's name; `priorTerminal` preserves the outcome that was
      // cleared so replay still shows the completed→running transition.
      type: "state_machine_reactivated";
      timestamp: number;
      state: string;
      priorTerminal: StateMachineTerminalResult;
    };
