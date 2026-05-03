import type { AgentRun } from "./agent.js";
import type {
  StateMachineDefinition,
  StateMachineRun,
  StateMachineRunStatus,
} from "./state-machine.js";

/**
 * Harness Protocol
 *
 * A JSON-friendly command/event protocol for operating duet-agent harnesses.
 * The transport is intentionally unspecified. A CLI, daemon, HTTP server, or
 * parent process can all speak this protocol as long as they can send commands
 * and consume streamed events.
 *
 * The protocol is not a comm layer. It is the control surface for the
 * harness itself:
 *
 * - commands tell the harness what to do
 * - turn events report work during the turn and end each turn
 *
 * ## Turn Model
 *
 * A user starts a turn by sending one of:
 *
 * - `start`: begin a new harness run from a prompt
 * - `prompt`: send a follow-up prompt while a run exists
 * - `answer`: answer questions from the previous terminal `ask` event
 *
 * The harness emits any number of during-turn events (`step`, `todos`,
 * `state_machine`, `log`). The turn ends with exactly one terminal event:
 * `complete`, `ask`, `interrupted`, or `sleep`.
 * Terminal events carry the harness-owned state needed to continue a later
 * turn. The agent run is always present because the agent owns the conversation
 * history and, for state-machine mode, drives state transitions.
 *
 * ## Scenario 1: One-Shot Agent Task
 *
 * The user asks for a normal task, such as "summarize this file" or "fix this
 * bug." The start command omits `mode` or sets `mode: "auto"`. The harness
 * classifies the prompt as agent mode and emits:
 *
 * 1. `run_started` with `run.agent` populated
 * 2. zero or more `step`, `todos`, or `log` events
 * 3. `complete` with the final answer and updated `run.agent`
 *
 * This behaves like a normal agent harness. There is no state-machine UI because
 * the run is not a long-running business process.
 *
 * ## Scenario 2: Auto-Selected State Machine
 *
 * The user asks for a task with a complex lifecycle, such as "prospect this
 * customer until they book a meeting" or "implement this change, open a PR, and
 * watch it until merge." With `mode: "auto"`, the harness chooses a state
 * machine and emits `run_started` with `run.agent` and `run.stateMachine`
 * populated.
 *
 * During the turn, the harness emits events that the UI can render directly:
 *
 * - `state_machine` shows the state-machine status and current state name
 * - `step` shows textual progress, reasoning, tool calls, or system messages
 * - `todos` shows current task progress
 * - `log` shows diagnostic messages
 *
 * The UI can always render `run.agent` as the conversation transcript. When it
 * also sees `run.stateMachine`, it can render a Kanban board for the state
 * machine. Each `state_machine` event moves the visible session card to the
 * current state column and updates the lifecycle status.
 *
 * ### Scenario 2a: User Follow-Up Interrupts The Turn
 *
 * While the state machine is running, the user can send a `prompt` command with
 * `behavior: "steer"`. The harness should treat this as additional user
 * context for the active pi session. For example, the user might say "I've
 * already received this email" while the state machine is waiting for a reply.
 * The harness agent can incorporate that message, update the state-machine
 * state, and then continue the same state-machine run instead of abandoning it.
 *
 * A typical stream is:
 *
 * 1. `step` events while the agent incorporates the user's update
 * 2. more `state_machine` events as the updated state machine continues
 * 3. a terminal event (`complete`, `ask`, `sleep`, or `interrupted`) carrying
 *    the updated `run`
 *
 * ### Scenario 2b: Polling Uses Sleep
 *
 * A state machine might send an email and then wait for a reply. This should be
 * modeled as a poll state, not as a user-owned infinite polling script. The
 * harness performs one poll attempt. If no reply exists yet, it emits a terminal
 * `sleep` event with `wakeAt`.
 *
 * The layer above the harness persists `run`, schedules a wakeup for `wakeAt`,
 * and starts the harness again at that time. On each wake, the harness performs
 * one more poll attempt. Once a reply is found, the harness records it in the
 * state-machine run and continues to the next state.
 *
 * ## Scenario 3: Explicit State Machine Definition
 *
 * A caller can pass a full `StateMachineDefinition` as `mode`.
 *
 * If the user's prompt matches the definition, the harness runs that state
 * machine directly and emits the same state-machine events as Scenario 2.
 *
 * If the user's prompt does not fit the provided definition, the harness should
 * answer normally in agent mode. Passing a state-machine definition is a strong
 * hint, not a reason to force an unrelated prompt through the wrong process.
 */

/**
 * Top-level execution mode for a prompt.
 *
 * - "agent": handle the prompt as a normal one-shot/current-run agent run.
 * - "auto": let the harness classify which mode the prompt needs.
 * - StateMachineDefinition: run this explicit state machine.
 */
export type HarnessMode = "agent" | "auto" | StateMachineDefinition;

export type ThinkingLevel = "none" | "auto" | "low" | "medium" | "high" | "xhigh";

/** Harness-owned state needed to continue a later turn. */
export interface HarnessRun {
  /** The agent conversation is always present, including state-machine runs. */
  agent: AgentRun;
  /** Present when this run is executing in state-machine mode. */
  stateMachine?: StateMachineRun;
}

/**
 * How a follow-up prompt should be delivered while a pi session is active.
 *
 * - "steer": deliver as an interruption/steering message to the active pi agent.
 * - "follow_up": queue until the active pi agent finishes its current turn.
 */
export type HarnessPromptBehavior = "steer" | "follow_up";

export type HarnessTerminalStatus = "completed" | "failed" | "cancelled";

export interface HarnessTurnOptions {
  /** Model override in provider:modelId format. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface HarnessQuestionOption {
  /** Display label shown to the user. */
  label: string;
  /** Optional extra context for the option. */
  description?: string;
}

export interface HarnessQuestion {
  /** Question text shown to the user. */
  question: string;
  /** Optional section heading for grouped questions. */
  header?: string;
  /** Available answers. */
  options: HarnessQuestionOption[];
  /** Whether multiple options can be selected. */
  multiSelect?: boolean;
}

export type HarnessTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface HarnessTodo {
  /** Stable UI-facing label for the work item. */
  content: string;
  /** Current progress state for the work item. */
  status: HarnessTodoStatus;
}

export interface HarnessTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export type HarnessStep =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      toolCallId: string;
      status: "pending" | "running" | "completed" | "error";
      input?: unknown;
    }
  | { type: "system"; message: string };

/**
 * Start a new orchestration run.
 *
 * The mode decides routing. Omit it to use the harness's configured default.
 */
export interface HarnessStartCommand {
  type: "start";
  /** User prompt to route through the harness. */
  prompt: string;
  /** Working directory for pi coding tools and script states. */
  cwd?: string;
  /** Routing mode. Omit to use the harness's configured default. */
  mode?: HarnessMode;
  options?: HarnessTurnOptions;
}

/** Send a new user prompt while a run is active. */
export interface HarnessPromptCommand {
  type: "prompt";
  /** Existing run to continue. */
  run: HarnessRun;
  message: string;
  /** Pi handles the underlying interruption/follow-up behavior. */
  behavior: HarnessPromptBehavior;
  options?: HarnessTurnOptions;
}

/** Provide answers to a structured question emitted by the harness. */
export interface HarnessAnswerCommand {
  type: "answer";
  /** Existing run to continue. */
  run: HarnessRun;
  questions: HarnessQuestion[];
  answers: Record<string, string>;
  options?: HarnessTurnOptions;
}

/** Ask the active pi agent/runtime to interrupt the current operation. */
export interface HarnessInterruptCommand {
  type: "interrupt";
  /** Existing run to interrupt. */
  run: HarnessRun;
}

export type HarnessCommand =
  | HarnessStartCommand
  | HarnessPromptCommand
  | HarnessAnswerCommand
  | HarnessInterruptCommand;

export interface HarnessReadyEvent {
  type: "ready";
}

export interface HarnessRunStartedEvent {
  type: "run_started";
  /** Full run object after applying config/options/auto routing. */
  run: HarnessRun;
}

export interface HarnessStepEvent {
  type: "step";
  step: HarnessStep;
}

export interface HarnessTodosEvent {
  type: "todos";
  todos: HarnessTodo[];
}

export interface HarnessStateMachineEvent {
  type: "state_machine";
  status: StateMachineRunStatus;
  /** Display name/title of the current state. */
  currentState: string;
}

export interface HarnessTerminalEvent {
  run: HarnessRun;
  usage?: HarnessTokenUsage;
}

export interface HarnessAskEvent extends HarnessTerminalEvent {
  type: "ask";
  questions: HarnessQuestion[];
}

export interface HarnessRunCompletedEvent extends HarnessTerminalEvent {
  type: "complete";
  status: HarnessTerminalStatus;
  result?: string;
  error?: string;
}

export interface HarnessInterruptedEvent extends HarnessTerminalEvent {
  type: "interrupted";
}

export interface HarnessSleepEvent extends HarnessTerminalEvent {
  type: "sleep";
  /** Unix timestamp in milliseconds when the outer layer should wake the harness. */
  wakeAt: number;
}

export interface HarnessLogEvent {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Events emitted while the harness is still working on the current turn. */
export type HarnessDuringTurnEvent =
  | HarnessStepEvent
  | HarnessTodosEvent
  | HarnessStateMachineEvent
  | HarnessLogEvent;

/** Events that end the current turn. */
export type HarnessTerminalTurnEvent =
  | HarnessAskEvent
  | HarnessRunCompletedEvent
  | HarnessInterruptedEvent
  | HarnessSleepEvent;

export type HarnessEvent =
  | HarnessReadyEvent
  | HarnessRunStartedEvent
  | HarnessDuringTurnEvent
  | HarnessTerminalTurnEvent;
