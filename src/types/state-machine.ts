/**
 * Durable state-machine definitions and runtime state.
 *
 * A state machine models the high-level business process, not task execution.
 * There is one current business state at a time. The state-machine runner agent
 * sees the original prompt, state-machine state, state history, and state
 * definitions, then decides which state should run next, whether the run should
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
 * research the company, draft/send outreach, then the state machine can suspend
 * while a polling script checks whether the prospect has replied or whether the
 * next follow-up date has arrived.
 *
 * The orchestrator should:
 *
 * 1. Start a StateMachineRun from a StateMachineDefinition and initialize durable domain
 *    state.
 * 2. Enter an agent state for enrichment/research and record the output in the
 *    run history so the state machine can resume without repeating research.
 * 3. Enter a send-email script state and record the sent message details.
 * 4. The runner can choose a waiting state backed by a user-provided script. That script can
 *    call any email/calendar/CRM API or CLI and should return structured data
 *    only when there is something for the state machine to do next, such as:
 *    - prospect replied
 *    - follow-up due
 *    - meeting scheduled
 *    - outreach window expired
 * 5. When the polling script returns a reply payload, resume the run and ask an
 *    agent to classify it: interested, negative, ad hoc question, neutral, or
 *    unclear.
 * 6. The runner chooses the appropriate next state based on that classification:
 *    - interested -> send Calendly / schedule-meeting state
 *    - ad hoc question -> answer question, then return to waiting
 *    - negative -> terminal state: prospect_not_interested
 *    - unclear -> ask a follow-up or wait for more context
 * 7. When the polling script returns follow-up_due, send a follow-up if the run
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
 * - durable domain state
 * - agent/tool/script states whose outputs are available through state-machine history
 * - waits backed by repeatable scripts, plus explicit waits for human input
 * - runner-agent decisions driven by full prompt, state, and history
 * - named terminal states richer than generic "completed" or "failed"
 *
 * Case 2: development state machine
 *
 * User provides a prompt. Agent/script states can create an isolated worktree,
 * run a dev agent, run a review agent, create a PR, poll until the PR is merged
 * or closed, then clean up the worktree.
 *
 * The orchestrator should:
 *
 * 1. Start a StateMachineRun from the user's prompt.
 * 2. Execute a script/tool state that creates a worktree and records its path in
 *    state-machine state/history.
 * 3. Execute an agent state that implements the requested code change inside the
 *    worktree.
 * 4. Execute a review agent state. The review can either approve, request fixes,
 *    or block the state machine.
 * 5. If fixes are requested, choose the dev-agent state again with the review
 *    feedback as input. The run history should preserve both attempts.
 * 6. When approved, execute a PR creation state and record PR number/URL.
 * 7. Enter a waiting state backed by a script. That script can use gh, git, or
 *    any other CLI/API wrapper to inspect the PR state and return:
 *    - merged -> continue to cleanup and terminal state: merged
 *    - closed -> continue to cleanup and terminal state: closed
 * 8. Execute cleanup using the recorded worktree path.
 *
 * The state-machine types should support this by representing:
 *
 * - a catalog of available business states
 * - retry/review loops without losing prior state history
 * - waits backed by regular polling scripts
 * - cleanup/finalizer states that run after terminal external outcomes
 * - terminal states such as merged, closed, failed_review, or cancelled
 *
 * In both cases, the orchestrator is responsible for asking the state-machine runner
 * agent what to do next, entering the selected state, recording the result, and
 * asking again. This lets the same state machine start in the middle when the user's
 * prompt says prior work already happened, such as "I've already sent email,
 * just wait for response." The orchestrator injects the original prompt and
 * relevant history automatically when constructing agent prompts; state
 * definitions only describe their own behavior. Waiting is intentionally simple:
 * either the user supplies input, or the orchestrator periodically runs a
 * configured script until it exits successfully / returns true / emits a
 * structured payload that satisfies the wait condition.
 *
 * Example of templated script commands:
 *
 * A setup state can emit structured output such as { "worktreePath": "..." }.
 * The orchestrator records that output in history and merges the structured
 * fields into state:
 *
 *   {
 *     kind: "script",
 *     command: "scripts/create-worktree.sh '{{ state.branchName }}'"
 *   }
 *
 * A later dev state or cleanup state can reference that state:
 *
 *   {
 *     kind: "script",
 *     command: "rm -rf '{{ state.worktreePath }}'"
 *   }
 *
 * A PR wait state can poll through any CLI/API wrapper without the state machine
 * engine knowing about GitHub:
 *
 *   {
 *     kind: "wait",
 *     wait: {
 *       kind: "poll_script",
 *       command: "scripts/check-pr-finished.sh '{{ state.prUrl }}'",
 *       intervalMs: 300000
 *     }
 *   }
 */

export type StateMachineId = string & { readonly __brand: "StateMachineId" };
export type StateMachineRunId = string & { readonly __brand: "StateMachineRunId" };
export type StateMachineStateId = string & { readonly __brand: "StateMachineStateId" };

export type StateMachineRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export type StateMachineStateStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "skipped";

export type StateMachineAgentContextScope = "state" | "dependencies" | "state_machine";

export type StateMachineRunnerDecision =
  /** Enter one of the available state machine states. */
  | { kind: "run_state"; stateId: StateMachineStateId; reason?: string }
  /** Suspend on a wait state until human input or a polling script resumes it. */
  | { kind: "wait"; stateId: StateMachineStateId; reason?: string }
  /** Execute/finalize with a terminal state. */
  | { kind: "terminal"; stateId: StateMachineStateId; reason?: string }
  /** Stop the run because no available state can make progress. */
  | { kind: "fail"; reason: string };

/** User-authored state machine template. Runtime progress lives in StateMachineRun. */
export interface StateMachineDefinition {
  id: StateMachineId;
  /** Human-readable label for selection in CLIs/UIs. */
  name: string;
  /** Explains what business/process outcome this state machine owns. */
  description?: string;
  /**
   * Instructions for the state-machine runner agent that chooses what state to execute
   * next from the prompt, state, history, and available state definitions.
   */
  runnerInstructions: string;
  /** Available states the runner agent can choose from, including terminal states. */
  states: StateMachineState[];
}

/**
 * Persisted execution state. The orchestrator can stop after any state and later
 * continue from this run without redoing completed work.
 */
export interface StateMachineRun {
  id: StateMachineRunId;
  stateMachineId: StateMachineId;
  /** High-level lifecycle used by schedulers to find active or waiting runs. */
  status: StateMachineRunStatus;
  /** Original user request that started the state machine. */
  prompt: string;
  /** Current business state, selected by the runner agent. */
  currentStateId?: StateMachineStateId;
  /** Mutable state machine memory shared across runner decisions and state templates. */
  state: Record<string, unknown>;
  /** Latest execution record per state; detailed attempts stay in history. */
  states: Record<string, StateMachineStateExecution>;
  /** Append-only audit log used for debugging, replay, and persistence. */
  history: StateMachineRunEvent[];
  /** Present only when status is waiting; the runner resumes after this wait completes. */
  waiting?: StateMachineWaitState;
  /** Present only after a run reaches a named terminal state. */
  terminal?: StateMachineTerminalResult;
  createdAt: number;
  updatedAt: number;
}

export type StateMachineState =
  | StateMachineAgentState
  | StateMachineScriptState
  | StateMachineWaitStateDefinition
  | StateMachineTerminalState;

export interface StateMachineBaseState {
  id: StateMachineStateId;
  /** Short label for status output. */
  title?: string;
  /** Helps the runner agent understand when this state is appropriate. */
  when?: string;
}

/** Runs an agent. The orchestrator injects original prompt/history outside this state config. */
export interface StateMachineAgentState extends StateMachineBaseState {
  kind: "agent";
  /**
   * Prompt/instructions for the agent. The orchestrator renders this as a
   * template before execution using run.state only. The original prompt and
   * broader history are added separately when the final agent prompt is
   * constructed.
   */
  instructions: string;
  /**
   * Controls how much state machine context the agent receives.
   *
   * - "state": rendered instructions and current state.
   * - "dependencies": state context plus runner-selected prerequisite history.
   * - "state_machine": state context plus full state-machine definition and full state history.
   */
  contextScope?: StateMachineAgentContextScope;
  /** Optional skill allowlist injected into this agent state. Omitted means use state machine/orchestrator defaults. */
  allowedSkills?: string[];
  /** Upper bound before the agent must yield control back to the orchestrator. */
  maxTurns?: number;
  /** Optional JSON Schema used to request and validate structured output before merging it into state. */
  outputSchema?: Record<string, unknown>;
}

/** Runs a shell command. This is the generic integration primitive. */
export interface StateMachineScriptState extends StateMachineBaseState {
  kind: "script";
  /**
   * Shell command used for integrations, setup, cleanup, and deterministic
   * checks. The orchestrator renders this as a template before execution using
   * run.state only; keep state-machine definitions serializable instead of storing
   * executable functions here.
   */
  command: string;
  /** Working directory for the command. Defaults to the state-machine runner cwd. */
  cwd?: string;
  /** Kills the command if it exceeds this runtime. */
  timeoutMs?: number;
  /** Exit codes treated as success. Defaults to [0]. */
  successCodes?: number[];
}

/** Suspends the run until human input arrives or a polling script succeeds. */
export interface StateMachineWaitStateDefinition extends StateMachineBaseState {
  kind: "wait";
  /** Describes how the run suspends and what input wakes it. */
  wait: StateMachineWait;
}

/** Finalizes the run when reached. Terminal outcomes are just state machine states. */
export interface StateMachineTerminalState extends StateMachineBaseState {
  kind: "terminal";
  /** Maps this named outcome to the run's lifecycle status. */
  status: "completed" | "failed" | "cancelled";
  /** Optional final explanation shown to users and recorded in history. */
  reason?: string;
}

export type StateMachineWait =
  | {
      kind: "human_input";
      /** Message shown to the human while the run is suspended. */
      prompt: string;
      /** Structured human input is recorded in history and merged into state. */
    }
  | {
      kind: "poll_script";
      /**
       * Command rerun by the scheduler until it succeeds or times out. Like
       * script-state commands, this is rendered as a template from run.state only
       * before each poll attempt.
       */
      command: string;
      /** Minimum delay between poll attempts. */
      intervalMs: number;
      /** Working directory for the poll command. */
      cwd?: string;
      /** Maximum time the state machine can remain in this wait before failing the run. */
      timeoutMs?: number;
      /** Exit codes that mean the wait condition is satisfied. Defaults to [0]. */
      successCodes?: number[];
      /** Successful structured poll output is recorded in history and merged into state. */
    };

export interface StateMachineTerminalResult {
  /** References the terminal state that finalized the run. */
  stateId: StateMachineStateId;
  /** Copied from the terminal state for easy querying. */
  status: StateMachineTerminalState["status"];
  /** Optional final explanation, often generated by the orchestrator. */
  reason?: string;
}

export interface StateMachineStateExecution {
  stateId: StateMachineStateId;
  /** Latest status for this state. */
  status: StateMachineStateStatus;
  /** Number of times the orchestrator attempted this state. */
  attempts: number;
  startedAt?: number;
  completedAt?: number;
  /** Latest failure message for observability and retry decisions. */
  error?: string;
}

export interface StateMachineWaitState {
  stateId: StateMachineStateId;
  /** Copy of the wait config so schedulers can wake the run without reloading the definition. */
  wait: StateMachineWait;
  startedAt: number;
  /** Scheduler hint for when the next poll attempt is allowed. */
  nextPollAt?: number;
  /** Last time the poll command actually ran. */
  lastPollAt?: number;
  /** Poll or resume attempts made while waiting. */
  attempts: number;
  /** Last polling error, useful for status displays and retry logic. */
  lastError?: string;
}

export type StateMachineRunEvent =
  | { type: "run_started"; timestamp: number }
  | { type: "runner_decided"; timestamp: number; decision: StateMachineRunnerDecision }
  | { type: "state_started"; timestamp: number; stateId: StateMachineStateId }
  | { type: "state_completed"; timestamp: number; stateId: StateMachineStateId }
  | { type: "state_failed"; timestamp: number; stateId: StateMachineStateId; error: string }
  | { type: "run_waiting"; timestamp: number; stateId: StateMachineStateId; wait: StateMachineWait }
  | { type: "run_resumed"; timestamp: number; stateId: StateMachineStateId; input?: unknown }
  | { type: "run_completed"; timestamp: number; terminal: StateMachineTerminalResult };
