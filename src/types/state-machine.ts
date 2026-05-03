import type { HarnessTurnOptions } from "./protocol.js";

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
 * research the company, draft/send outreach, then a poll state can check whether
 * the prospect has replied or whether the next follow-up date has arrived.
 *
 * The harness should:
 *
 * 1. Start a StateMachineRun from a StateMachineDefinition and initialize durable domain
 *    state.
 * 2. Enter an agent state for enrichment/research and record the output in the
 *    run history so the state machine can resume without repeating research.
 * 3. Enter a send-email script state and record the sent message details.
 * 4. The runner can choose a poll state. The harness runs one poll attempt,
 *    emits a sleep event if nothing changed, and relies on the outer layer to
 *    wake it later. A poll attempt can run a script or prompt an agent, and
 *    should return structured data only when there is something for the state
 *    machine to do next, such as:
 *    - prospect replied
 *    - follow-up due
 *    - meeting scheduled
 *    - outreach window expired
 * 5. When polling returns a reply payload, resume the run and ask an
 *    agent to classify it: interested, negative, ad hoc question, neutral, or
 *    unclear.
 * 6. The runner chooses the appropriate next state based on that classification:
 *    - interested -> send Calendly / schedule-meeting state
 *    - ad hoc question -> answer question, then return to waiting
 *    - negative -> terminal state: prospect_not_interested
 *    - unclear -> ask a follow-up or wait for more context
 * 7. When polling returns follow-up_due, send a follow-up if the run
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
 * - poll states, plus explicit waits for human input
 * - runner-agent decisions driven by full prompt, state, and history
 * - named terminal states richer than generic "completed" or "failed"
 *
 * Case 2: development state machine
 *
 * User provides a prompt. Agent/script states can create an isolated worktree,
 * run a dev agent, run a review agent, create a PR, poll until the PR is merged
 * or closed, then clean up the worktree.
 *
 * The harness should:
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
 * In both cases, the harness is responsible for asking the state-machine runner
 * agent what to do next, entering the selected state, recording the result, and
 * asking again. This lets the same state machine start in the middle when the user's
 * prompt says prior work already happened, such as "I've already sent email,
 * just wait for response." The harness injects the original prompt and
 * relevant history automatically when constructing agent prompts; state
 * definitions only describe their own behavior. Human input is not a separate
 * state-machine state: if the current state is an agent state and the harness
 * run is waiting_for_human, the state machine is waiting for that agent's user
 * input. Polling remains explicit because the harness owns one poll attempt and
 * emits sleep until the next attempt.
 *
 * Example of templated script commands:
 *
 * A setup state can emit structured output such as { "worktreePath": "..." }.
 * The harness records that output in history and merges the structured
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
 * A PR poll state can check through any CLI/API wrapper without the state
 * machine engine knowing about GitHub:
 *
 *   {
 *     kind: "poll",
 *     poll: {
 *       kind: "script",
 *       command: "scripts/check-pr-finished.sh '{{ state.prUrl }}'"
 *     },
 *     intervalMs: 300000
 *   }
 */

export type StateMachineAgentContextScope = "state" | "dependencies" | "state_machine";

export type StateMachineRunnerDecision =
  /** Enter one of the available state machine states. */
  | { kind: "run_state"; state: string; reason?: string }
  /** Execute/finalize with a terminal state. */
  | { kind: "terminal"; state: string; reason?: string }
  /** Stop the run because no available state can make progress. */
  | { kind: "fail"; reason: string };

/** User-authored state machine template. Runtime progress lives in StateMachineRun. */
export interface StateMachineDefinition {
  /** Human-readable label for selection in CLIs/UIs. */
  name: string;
  /**
   * Routing guidance for the harness agent. This explains when this definition's
   * set of states applies; if the user's request does not match this prompt, the
   * selected state can be undefined and the harness can answer normally in agent mode.
   */
  prompt: string;
  /** Available states the runner agent can choose from, including terminal states. */
  states: StateMachineState[];
}

/**
 * Persisted execution state. The harness can stop after any state and later
 * continue from this run without redoing completed work.
 */
export interface StateMachineRun {
  /** Original user request that started the state machine. */
  prompt: string;
  /** Current business state, selected by the runner agent. */
  currentState?: string;
  /** Mutable state machine memory shared across runner decisions and state templates. */
  state: Record<string, unknown>;
  /** Append-only audit log used for debugging, replay, and persistence. */
  history: StateMachineRunEvent[];
  /** Present only after a run reaches a named terminal state. */
  terminal?: StateMachineTerminalResult;
  createdAt: number;
  updatedAt: number;
}

export type StateMachineState =
  | StateMachineAgentState
  | StateMachineScriptState
  | StateMachinePollState
  | StateMachineTerminalState;

export interface StateMachineBaseState {
  /** Name shown in status output and used by the runner when choosing a state. */
  name: string;
  /** Helps the runner agent understand when this state is appropriate. */
  when?: string;
}

/** Runs an agent. The harness injects original prompt/history outside this state config. */
export interface StateMachineAgentState extends StateMachineBaseState {
  kind: "agent";
  /**
   * Prompt for the agent. The harness renders this as a template before
   * execution using run.state only. The original user prompt and
   * broader history are added separately when the final agent prompt is
   * constructed.
   */
  prompt: string;
  /**
   * Controls how much state machine context the agent receives.
   *
   * - "state": rendered prompt and current state.
   * - "dependencies": state context plus runner-selected prerequisite history.
   * - "state_machine": state context plus full state-machine definition and full state history.
   */
  contextScope?: StateMachineAgentContextScope;
  /** Optional skill allowlist injected into this agent state. Omitted means use state machine/harness defaults. */
  allowedSkills?: string[];
  /** Per-state model/thinking overrides for this agent turn. */
  options?: HarnessTurnOptions;
  /** Upper bound before the agent must yield control back to the harness. */
  maxTurns?: number;
  /** Optional JSON Schema used to request and validate structured output before merging it into state. */
  outputSchema?: Record<string, unknown>;
}

/** Runs a shell command. This is the generic integration primitive. */
export interface StateMachineScriptState extends StateMachineBaseState {
  kind: "script";
  /**
   * Shell command used for integrations, setup, cleanup, and deterministic
   * checks. The harness renders this as a template before execution using
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

/** Performs one external check, then either records data or sleeps until the next attempt. */
export interface StateMachinePollState extends StateMachineBaseState {
  kind: "poll";
  /** How often the protocol layer should wake the harness for another attempt. */
  intervalMs: number;
  /** Maximum time the state machine can remain in this poll state before failing the run. */
  timeoutMs?: number;
  /** One polling attempt. The harness owns the polling loop and emits sleep between attempts. */
  poll: StateMachinePoll;
}

export type StateMachinePoll =
  | {
      kind: "script";
      /**
       * Runs once per poll attempt. The command should return structured output
       * only when something changed; otherwise the harness sleeps and tries again.
       */
      command: string;
      cwd?: string;
      /** Exit codes that mean this poll found a result. Defaults to [0]. */
      successCodes?: number[];
    }
  | {
      kind: "prompt";
      /**
       * Prompt used once per poll attempt when the check needs an agent to inspect
       * an external source through available tools.
       */
      prompt: string;
      outputSchema?: Record<string, unknown>;
    };

/** Finalizes the run when reached. Terminal outcomes are just state machine states. */
export interface StateMachineTerminalState extends StateMachineBaseState {
  kind: "terminal";
  /** Maps this named outcome to the run's lifecycle status. */
  status: "completed" | "failed" | "cancelled";
  /** Optional final explanation shown to users and recorded in history. */
  reason?: string;
}

export interface StateMachineTerminalResult {
  /** Names the terminal state that finalized the run. */
  state: string;
  /** Copied from the terminal state for easy querying. */
  status: StateMachineTerminalState["status"];
  /** Optional final explanation, often generated by the harness. */
  reason?: string;
}

export type StateMachineRunEvent =
  | { type: "run_started"; timestamp: number }
  | { type: "runner_decided"; timestamp: number; decision: StateMachineRunnerDecision }
  | { type: "state_started"; timestamp: number; state: string }
  | { type: "state_completed"; timestamp: number; state: string }
  | { type: "state_failed"; timestamp: number; state: string; error: string }
  | { type: "run_resumed"; timestamp: number; state: string; input?: unknown }
  | { type: "run_completed"; timestamp: number; terminal: StateMachineTerminalResult };
