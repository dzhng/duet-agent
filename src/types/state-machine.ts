import type { TurnQuestion } from "./protocol.js";

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
 * their own behavior. Human input is not a separate state-machine state: if the
 * current state is an agent state and the runner state is waiting_for_human, the
 * state machine is waiting for that agent's user input. Polling remains explicit
 * because the runner owns one poll attempt and emits sleep until the next attempt.
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
 *     poll: {
 *       kind: "script",
 *       command: "scripts/check-pr-finished.sh '{{ input.prUrl }}'"
 *     },
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
   * Persisted so sleeping poll states can resume with the same template values.
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
  createdAt: number;
  updatedAt: number;
}

export type StateMachineState =
  | StateMachineAgentState
  | StateMachineScriptState
  | StateMachinePollState
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
  /** How often the protocol layer should wake the runner for another attempt. */
  intervalMs: number;
  /** Maximum time the state machine can remain in this poll state before failing the session. */
  timeoutMs?: number;
  /** One polling attempt. The runner owns the polling loop and emits sleep between attempts. */
  poll: StateMachinePoll;
}

export type StateMachinePoll =
  | {
      kind: "script";
      /**
       * Runs once per poll attempt. The command should return structured output
       * only when something changed; otherwise the runner sleeps and tries again.
       */
      command: string;
      cwd?: string;
      /** Exit codes that mean this poll found a result. Defaults to [0]. */
      successCodes?: number[];
    }
  | {
      kind: "timer";
      /**
       * Pure delay poll. The first visit sleeps; the scheduled wake lets the
       * parent runner choose the next state without invoking a script or agent.
       */
    };

/** Finalizes the session when reached. Terminal outcomes are just state machine states. */
export interface StateMachineTerminalState extends StateMachineBaseState {
  kind: "terminal";
  /** Maps this named outcome to the session's lifecycle status. */
  status: "completed" | "failed" | "cancelled";
  /** Optional final explanation shown to users and recorded in history. */
  reason?: string;
}

export interface StateMachineTerminalResult {
  /** Names the terminal state that finalized the session. */
  state: string;
  /** Copied from the terminal state for easy querying. */
  status: StateMachineTerminalState["status"];
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
      type: "state_asked_user";
      timestamp: number;
      state: string;
      questions: TurnQuestion[];
    }
  | { type: "state_machine_completed"; timestamp: number; terminal: StateMachineTerminalResult };
