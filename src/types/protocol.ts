import type { SessionId } from "./identity.js";
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
 * - command responses acknowledge commands
 * - turn events report work during the turn and end each turn
 *
 * Each command carries an `id` for response correlation. Events are not tied to
 * command IDs; they describe the ongoing run.
 */

/**
 * Top-level execution mode for a prompt.
 *
 * - "agent": handle the prompt as a normal one-shot/current-run agent run.
 * - "auto": let the harness classify which mode the prompt needs.
 * - StateMachineDefinition: run this explicit state machine.
 */
export type HarnessMode = "agent" | "auto" | StateMachineDefinition;

export type HarnessTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface HarnessTodo {
  /** Stable UI-facing label for the work item. */
  content: string;
  /** Current progress state for the work item. */
  status: HarnessTodoStatus;
}

/** Run snapshot used for start, resume, and terminal events. */
export interface HarnessRun {
  sessionId: SessionId;
  goal: string;
  mode: Exclude<HarnessMode, "auto">;
  status: HarnessRunStatus;
  todos: HarnessTodo[];
  context: Record<string, unknown>;
  /** Present when this run is executing a state machine. */
  stateMachine?: StateMachineRun;
}

/**
 * How a follow-up prompt should be delivered while a pi session is active.
 *
 * - "steer": deliver as an interruption/steering message to the active pi agent.
 * - "follow_up": queue until the active pi agent finishes its current turn.
 */
export type HarnessPromptBehavior = "steer" | "follow_up";

export type HarnessRunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

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
  id: string;
  type: "start";
  /** User prompt to route through the harness. */
  prompt: string;
  /** Working directory for pi coding tools and script states. */
  cwd?: string;
  /** Routing mode. Omit to use the harness's configured default. */
  mode?: HarnessMode;
  /** Optional model override in provider:modelId format. */
  model?: string;
  /** Existing run to continue. */
  resume?: HarnessRun;
}

/** Send a new user prompt while a run is active. */
export interface HarnessPromptCommand {
  id: string;
  type: "prompt";
  message: string;
  /** Pi handles the underlying interruption/follow-up behavior. */
  behavior: HarnessPromptBehavior;
}

/** Provide answers to a structured question emitted by the harness. */
export interface HarnessAnswerCommand {
  id: string;
  type: "answer";
  questions: HarnessQuestion[];
  answers: Record<string, string>;
}

/** Ask the active pi agent/runtime to interrupt the current operation. */
export interface HarnessInterruptCommand {
  id: string;
  type: "interrupt";
}

/** Change the default top-level execution mode for future starts. */
export interface HarnessSetModeCommand {
  id: string;
  type: "set_mode";
  mode: HarnessMode;
}

/** Change the harness model for future model calls. */
export interface HarnessSetModelCommand {
  id: string;
  type: "set_model";
  model: string;
}

export type HarnessCommand =
  | HarnessStartCommand
  | HarnessPromptCommand
  | HarnessAnswerCommand
  | HarnessInterruptCommand
  | HarnessSetModeCommand
  | HarnessSetModelCommand;

/** Acknowledge a command. Every command must receive exactly one response. */
export interface HarnessResponse {
  id: string;
  type: "response";
  command: HarnessCommand["type"];
  success: boolean;
  error?: string;
}

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
  status: Extract<HarnessRunStatus, "completed" | "failed" | "cancelled">;
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
  | HarnessResponse
  | HarnessRunStartedEvent
  | HarnessDuringTurnEvent
  | HarnessTerminalTurnEvent;
