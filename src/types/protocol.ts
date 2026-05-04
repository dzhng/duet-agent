import type { ThinkingLevel } from "@mariozechner/pi-ai";
import type { AgentSession } from "./agent.js";
import type { StateMachineDefinition, StateMachineSession } from "./state-machine.js";

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
 * - `start`: begin a new harness session from a prompt
 * - `prompt`: send a follow-up prompt while a session exists
 * - `answer`: answer questions from the previous terminal `ask` event
 * - `wake`: resume a sleeping session for one scheduled polling attempt
 *
 * The harness must emit `ready` before any other event. A harness that is not
 * ready should not emit session, progress, or terminal events. After `ready`, the
 * harness emits any number of during-turn events (`step`, `todos`,
 * `state_machine`, `log`). The turn ends with exactly one terminal event:
 * `complete`, `ask`, `interrupted`, or `sleep`.
 * Terminal events carry the harness-owned state needed to continue a later
 * turn. The agent session is always present because the agent owns the conversation
 * history and, for state-machine mode, drives state transitions.
 *
 * ## Scenario 1: One-Shot Agent Task
 *
 * The user asks for a normal task, such as "summarize this file" or "fix this
 * bug." The start command omits `mode` or sets `mode: "auto"`. The harness
 * classifies the prompt as agent mode and emits:
 *
 * 1. `ready`
 * 2. `session_started` with `session.agent` populated
 * 3. zero or more `step`, `todos`, or `log` events
 * 4. `complete` with the final answer and updated `session.agent`
 *
 * This behaves like a normal agent harness. There is no state-machine UI because
 * the session is not a long-running business process.
 *
 * ## Scenario 2: Auto-Selected State Machine
 *
 * The user asks for a task with a complex lifecycle, such as "prospect this
 * customer until they book a meeting" or "implement this change, open a PR, and
 * watch it until merge." With `mode: "auto"`, the harness chooses a state
 * machine and emits `session_started` with `session.agent` and `session.stateMachine`
 * populated.
 *
 * During the turn, the harness emits events that the UI can render directly:
 *
 * - `state_machine` shows the current state name
 * - `step` shows textual progress, reasoning, tool calls, or system messages
 * - `todos` shows current task progress
 * - `log` shows diagnostic messages
 *
 * The UI can always render `session.agent` as the conversation transcript. When it
 * also sees `session.stateMachine`, it can render a Kanban board for the state
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
 * state, and then continue the same state-machine session instead of abandoning it.
 *
 * A typical stream is:
 *
 * 1. `step` events while the agent incorporates the user's update
 * 2. more `state_machine` events as the updated state machine continues
 * 3. a terminal event (`complete`, `ask`, `sleep`, or `interrupted`) carrying
 *    the updated `session`
 *
 * ### Scenario 2b: Polling Uses Sleep
 *
 * A state machine might send an email and then wait for a reply. This should be
 * modeled as a poll state, not as a user-owned infinite polling script. The
 * harness performs one poll attempt. If no reply exists yet, it emits a terminal
 * `sleep` event with `wakeAt`.
 *
 * The layer above the harness persists `session`, schedules a wakeup for `wakeAt`,
 * and starts the harness again at that time. On each wake, the harness performs
 * one more poll attempt. Once a reply is found, the harness records it in the
 * state-machine session and continues to the next state.
 *
 * ## Scenario 3: Explicit State Machine Definition
 *
 * A caller can pass a full `StateMachineDefinition` as `mode`. The definition
 * is a set of possible states the harness may use, not a command to force every
 * prompt into that state machine.
 *
 * If the user's prompt matches the definition, the harness runs that state
 * machine directly and emits the same state-machine events as Scenario 2.
 *
 * If the user's prompt does not fit the provided definition, the harness should
 * answer normally in agent mode. Conceptually, the selected state can be
 * `undefined`: none of the possible states fit the user's request.
 */

/**
 * Top-level execution mode for a prompt.
 *
 * - "agent": handle the prompt as a normal one-shot/current-session agent session.
 * - "auto": let the harness classify which mode the prompt needs. Auto sessions
 *   may create new state-machine definitions over time, even after a previous
 *   state machine reached a terminal state.
 * - StateMachineDefinition: use this explicit set of possible states when it fits.
 *   Explicit-definition sessions are constrained to this definition; if none of its
 *   states fit, the selected state can be undefined and the harness can answer normally.
 */
export type HarnessMode = "agent" | "auto" | StateMachineDefinition;

export type HarnessTerminalStatus = "completed" | "failed" | "cancelled";

export type HarnessSessionStatus =
  | "running"
  | "waiting_for_human"
  | "sleeping"
  | "interrupted"
  | HarnessTerminalStatus;

/** Harness-owned state needed to continue a later turn. */
export interface HarnessSession {
  /** Lifecycle of the whole harness session, regardless of agent or state-machine mode. */
  status: HarnessSessionStatus;
  /**
   * The mode originally used to start the session. This is required on resume so
   * "auto" sessions can keep creating definitions while explicit-definition sessions
   * stay constrained to their provided state set.
   */
  mode: HarnessMode;
  /** The agent conversation is always present, including state-machine sessions. */
  agent: AgentSession;
  /** Present when this session is executing in state-machine mode. */
  stateMachine?: StateMachineSession;
}

/**
 * How a follow-up prompt should be delivered while a pi session is active.
 *
 * - "steer": deliver as an interruption/steering message to the active pi agent.
 * - "follow_up": queue until the active pi agent finishes its current turn.
 */
export type HarnessPromptBehavior = "steer" | "follow_up";

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
 * Start a new orchestration session.
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

/** Send a new user prompt while a session is active. */
export interface HarnessPromptCommand {
  type: "prompt";
  /** Existing session to continue. */
  session: HarnessSession;
  message: string;
  /** Pi handles the underlying interruption/follow-up behavior. */
  behavior: HarnessPromptBehavior;
  options?: HarnessTurnOptions;
}

/** Provide answers to a structured question emitted by the harness. */
export interface HarnessAnswerCommand {
  type: "answer";
  /** Existing session to continue. */
  session: HarnessSession;
  questions: HarnessQuestion[];
  answers: Record<string, string>;
  /** Pi handles the underlying interruption/follow-up behavior. */
  behavior: HarnessPromptBehavior;
  options?: HarnessTurnOptions;
}

/** Wake a sleeping session. If the session is not sleeping on a poll state, this is a no-op. */
export interface HarnessWakeCommand {
  type: "wake";
  /** Existing session to wake. */
  session: HarnessSession;
  options?: HarnessTurnOptions;
}

export type HarnessTurnCommand =
  | HarnessStartCommand
  | HarnessPromptCommand
  | HarnessAnswerCommand
  | HarnessWakeCommand;

/** Out-of-band control message that interrupts the currently running turn. */
export interface HarnessInterruptCommand {
  type: "interrupt";
  /** Current session state known by the caller at the time of interruption. */
  session: HarnessSession;
}

export type HarnessCommand = HarnessTurnCommand | HarnessInterruptCommand;

export interface HarnessReadyEvent {
  type: "ready";
}

export interface HarnessSessionStartedEvent {
  type: "session_started";
  /** Full session object after applying config/options/auto routing. */
  session: HarnessSession;
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
  /** Display name/title of the current state. */
  currentState: string;
}

export interface HarnessTerminalEvent {
  session: HarnessSession;
  usage?: HarnessTokenUsage;
}

export interface HarnessAskEvent extends HarnessTerminalEvent {
  type: "ask";
  questions: HarnessQuestion[];
}

export interface HarnessSessionCompletedEvent extends HarnessTerminalEvent {
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
  | HarnessSessionCompletedEvent
  | HarnessInterruptedEvent
  | HarnessSleepEvent;

export type HarnessEvent =
  | HarnessReadyEvent
  | HarnessSessionStartedEvent
  | HarnessDuringTurnEvent
  | HarnessTerminalTurnEvent;
