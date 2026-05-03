import type { SessionId } from "./identity.js";
import type {
  StateMachineDefinition,
  StateMachineRun,
  StateMachineRunStatus,
} from "./state-machine.js";

/**
 * Orchestrator Protocol
 *
 * A JSON-friendly command/event protocol for operating duet-agent orchestrators.
 * The transport is intentionally unspecified. A CLI, daemon, HTTP server, or
 * parent process can all speak this protocol as long as they can send commands
 * and consume streamed events.
 *
 * The protocol is not a comm layer. It is the control surface for the
 * orchestrator itself:
 *
 * - commands tell the orchestrator what to do
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
 * - "auto": let the orchestrator classify which mode the prompt needs.
 * - StateMachineDefinition: run this explicit state machine.
 */
export type OrchestratorMode = "agent" | "auto" | StateMachineDefinition;

export type OrchestratorTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface OrchestratorTodo {
  /** Stable UI-facing label for the work item. */
  content: string;
  /** Current progress state for the work item. */
  status: OrchestratorTodoStatus;
}

/** Run snapshot used for start, resume, and terminal events. */
export interface OrchestratorRun {
  sessionId: SessionId;
  goal: string;
  mode: Exclude<OrchestratorMode, "auto">;
  status: OrchestratorRunStatus;
  todos: OrchestratorTodo[];
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
export type OrchestratorPromptBehavior = "steer" | "follow_up";

export type OrchestratorRunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface OrchestratorQuestionOption {
  /** Display label shown to the user. */
  label: string;
  /** Optional extra context for the option. */
  description?: string;
}

export interface OrchestratorQuestion {
  /** Question text shown to the user. */
  question: string;
  /** Optional section heading for grouped questions. */
  header?: string;
  /** Available answers. */
  options: OrchestratorQuestionOption[];
  /** Whether multiple options can be selected. */
  multiSelect?: boolean;
}

export interface OrchestratorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export type OrchestratorStep =
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
 * The mode decides routing. Omit it to use the orchestrator's configured default.
 */
export interface OrchestratorStartCommand {
  id: string;
  type: "start";
  /** User prompt to route through the orchestrator. */
  prompt: string;
  /** Working directory for pi coding tools and script states. */
  cwd?: string;
  /** Routing mode. Omit to use the orchestrator's configured default. */
  mode?: OrchestratorMode;
  /** Optional model override in provider:modelId format. */
  model?: string;
  /** Existing run to continue. */
  resume?: OrchestratorRun;
}

/** Send a new user prompt while a run is active. */
export interface OrchestratorPromptCommand {
  id: string;
  type: "prompt";
  message: string;
  /** Pi handles the underlying interruption/follow-up behavior. */
  behavior: OrchestratorPromptBehavior;
}

/** Provide answers to a structured question emitted by the orchestrator. */
export interface OrchestratorAnswerCommand {
  id: string;
  type: "answer";
  questions: OrchestratorQuestion[];
  answers: Record<string, string>;
}

/** Ask the active pi agent/runtime to interrupt the current operation. */
export interface OrchestratorInterruptCommand {
  id: string;
  type: "interrupt";
}

/** Change the default top-level execution mode for future starts. */
export interface OrchestratorSetModeCommand {
  id: string;
  type: "set_mode";
  mode: OrchestratorMode;
}

/** Change the orchestrator model for future model calls. */
export interface OrchestratorSetModelCommand {
  id: string;
  type: "set_model";
  model: string;
}

export type OrchestratorCommand =
  | OrchestratorStartCommand
  | OrchestratorPromptCommand
  | OrchestratorAnswerCommand
  | OrchestratorInterruptCommand
  | OrchestratorSetModeCommand
  | OrchestratorSetModelCommand;

/** Acknowledge a command. Every command must receive exactly one response. */
export interface OrchestratorResponse {
  id: string;
  type: "response";
  command: OrchestratorCommand["type"];
  success: boolean;
  error?: string;
}

export interface OrchestratorReadyEvent {
  type: "ready";
}

export interface OrchestratorRunStartedEvent {
  type: "run_started";
  /** Full run object after applying config/options/auto routing. */
  run: OrchestratorRun;
}

export interface OrchestratorStepEvent {
  type: "step";
  step: OrchestratorStep;
}

export interface OrchestratorTodosEvent {
  type: "todos";
  todos: OrchestratorTodo[];
}

export interface OrchestratorStateMachineEvent {
  type: "state_machine";
  status: StateMachineRunStatus;
  /** Display name/title of the current state. */
  currentState: string;
}

export interface OrchestratorTerminalEvent {
  run: OrchestratorRun;
  usage?: OrchestratorTokenUsage;
}

export interface OrchestratorAskEvent extends OrchestratorTerminalEvent {
  type: "ask";
  questions: OrchestratorQuestion[];
}

export interface OrchestratorRunCompletedEvent extends OrchestratorTerminalEvent {
  type: "complete";
  status: Extract<OrchestratorRunStatus, "completed" | "failed" | "cancelled">;
  result?: string;
  error?: string;
}

export interface OrchestratorInterruptedEvent extends OrchestratorTerminalEvent {
  type: "interrupted";
}

export interface OrchestratorSleepEvent extends OrchestratorTerminalEvent {
  type: "sleep";
  /** Unix timestamp in milliseconds when the outer layer should wake the harness. */
  wakeAt: number;
}

export interface OrchestratorLogEvent {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Events emitted while the harness is still working on the current turn. */
export type OrchestratorDuringTurnEvent =
  | OrchestratorStepEvent
  | OrchestratorTodosEvent
  | OrchestratorStateMachineEvent
  | OrchestratorLogEvent;

/** Events that end the current turn. */
export type OrchestratorTerminalTurnEvent =
  | OrchestratorAskEvent
  | OrchestratorRunCompletedEvent
  | OrchestratorInterruptedEvent
  | OrchestratorSleepEvent;

export type OrchestratorEvent =
  | OrchestratorReadyEvent
  | OrchestratorResponse
  | OrchestratorRunStartedEvent
  | OrchestratorDuringTurnEvent
  | OrchestratorTerminalTurnEvent;
