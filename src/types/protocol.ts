import type { ImageContent, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent.js";
import type { ObservationalMemoryActivityEvent } from "./memory.js";
import type { StateMachineDefinition, StateMachineSession } from "./state-machine.js";

/**
 * TurnRunner Protocol
 *
 * A JSON-friendly command/event protocol for operating duet turn runners.
 * The transport is intentionally unspecified. A CLI, daemon, HTTP server, or
 * parent process can all speak this protocol as long as they can send commands
 * and consume streamed events.
 *
 * The protocol is not a comm layer. It is the control surface for the
 * runner itself:
 *
 * - commands tell the runner what to do
 * - turn events report work during the turn and end each turn
 *
 * ## Turn Model
 *
 * The runner is a stateful turn executor: `start` bootstraps the current
 * `TurnState`, and each terminal event returns the next snapshot. The session
 * is the persistence owner. It assigns session ids, hydrates stored snapshots
 * before start, persists terminal snapshots, schedules wakeups, and can run an
 * unbounded number of turn-runner turns for the same user session.
 *
 * A caller initializes a session by sending `start`. This is a setup command,
 * not a turn: the runner loads memory and skills, emits `turn_started`
 * with the initial empty `TurnState`, and returns. Skills, agent files, and
 * skill collisions are exposed through `getSkills()`, `getResolvedAgentFiles()`,
 * and `getSkillCollisions()` for callers (CLI/TUI) that want to render a
 * setup summary; no agent work runs until the caller sends a follow-up.
 *
 * Once the session is set up, callers run turns by sending one of:
 *
 * - `prompt`: send a user prompt against the current state
 * - `answer`: answer questions from the previous terminal `ask` event
 * - `wake`: resume a sleeping session for one scheduled state-machine step
 *
 * Each turn emits any number of during-turn events (`step`, `todos`,
 * `follow_up_queue`, `state_machine`, `log`). The turn ends with exactly one
 * terminal event:
 * `complete`, `ask`, `interrupted`, or `sleep`.
 * Terminal events carry the turn runner-owned state needed to continue a later turn.
 * `complete` means this turn-runner turn ended; it does not mean the session
 * session is finished. A user can follow up with another prompt for the same
 * session; the runner continues from its internally held `TurnState`. The
 * agent session is always present because the agent owns the conversation
 * history and, for state-machine mode, drives state transitions.
 *
 * ## Scenario 1: One-Shot Agent Task
 *
 * The user asks for a normal task, such as "summarize this file" or "fix this
 * bug." The caller sends `start` (omitting `mode` or setting `mode: "auto"`)
 * to set the session up; the runner emits `turn_started` with an empty
 * `state.agent`. When the user types their first prompt, the caller sends a
 * `prompt` command and the runner classifies it as agent mode and emits:
 *
 * 1. zero or more `step`, `todos`, `follow_up_queue`, or `log` events
 * 2. `complete` with the final answer and updated `state.agent`
 *
 * This behaves like a normal agent runner. There is no state-machine UI because
 * the session is not a long-running business process.
 *
 * ## Scenario 2: Auto-Selected State Machine
 *
 * The user asks for a task with a complex lifecycle, such as "prospect this
 * customer until they book a meeting" or "implement this change, open a PR, and
 * watch it until merge." With `mode: "auto"`, the first `prompt` after `start`
 * routes through the runner, which chooses a state machine and populates
 * `state.stateMachine` on the next emitted state.
 *
 * During the turn, the runner emits events that the UI can render directly:
 *
 * - `state_machine` shows the current state name
 * - `step` shows textual progress, reasoning, tool calls, or system messages
 * - `todos` shows current task progress
 * - `follow_up_queue` shows prompts waiting for the current turn chain to finish
 * - `log` shows diagnostic messages
 *
 * The UI can always render `state.agent` as the conversation transcript. When it
 * also sees `state.stateMachine`, it can render a Kanban board for the state
 * machine. Each `state_machine` event moves the visible session card to the
 * current state column and updates the lifecycle status.
 *
 * ### Scenario 2a: User Follow-Up Interrupts The Turn
 *
 * While the state machine is running, the user can send a `prompt` command with
 * `behavior: "steer"`. The runner should treat this as additional user
 * context for the active pi session. For example, the user might say "I've
 * already received this email" while the state machine is waiting for a reply.
 * The runner agent can incorporate that message, update the state-machine
 * state, and then continue the same state-machine session instead of abandoning it.
 *
 * A typical stream is:
 *
 * 1. `step` events while the agent incorporates the user's update
 * 2. more `state_machine` events as the updated state machine continues
 * 3. a terminal event (`complete`, `ask`, `sleep`, or `interrupted`) carrying
 *    the updated `state`
 *
 * ### Scenario 2b: Scheduled States Use Sleep
 *
 * A state machine might send an email and then wait for a reply, or pause until
 * a specific timestamp. Recurring external checks should be modeled as poll
 * states, not as user-owned infinite polling scripts. Absolute waits should be
 * modeled as timer states. When scheduled work needs to wait, the runner emits
 * a terminal `sleep` event with `wakeAt`.
 *
 * The layer above the runner persists the state, schedules a wakeup for `wakeAt`,
 * and starts the runner again at that time. On each wake, the runner performs
 * the scheduled poll attempt or completes the timer state. Once scheduled work
 * finishes, the runner records it in the state-machine session and continues to
 * the next state.
 *
 * If the user sends a prompt while the session is sleeping on a
 * scheduled state, the session cancels the pending wake, runs that prompt
 * as a normal turn-runner turn, and returns the session to `sleep` if the state
 * machine is still waiting. The user should not see a stable `complete` state
 * while the business process is actually waiting on something external.
 *
 * ### Scenario 2c: Interrupting State-Machine Work
 *
 * An interrupt stops active turn-runner work for the current turn. If a state-machine
 * session is active, interruption also records an interrupted state-machine
 * terminal marker. Scheduled wakeups are owned by the session and are cancelled
 * there. A later user prompt starts a new turn from the interrupted state; the
 * parent agent can choose the right continuation.
 *
 * ## Scenario 3: Explicit State Machine Definition
 *
 * A caller can pass a full `StateMachineDefinition` as `mode`. The definition
 * is a set of possible states the runner may use, not a command to force every
 * prompt into that state machine.
 *
 * If the user's prompt matches the definition, the runner runs that state
 * machine directly and emits the same state-machine events as Scenario 2.
 *
 * If the user's prompt does not fit the provided definition, the runner should
 * answer normally in agent mode. Conceptually, the selected state can be
 * `undefined`: none of the possible states fit the user's request.
 */

/**
 * Top-level execution mode for a prompt.
 *
 * - "agent": handle the prompt as a normal one-shot/current-session agent session.
 * - "auto": let the runner classify which mode the prompt needs. Auto sessions
 *   may create new state-machine definitions over time, even after a previous
 *   state machine reached a terminal state.
 * - StateMachineDefinition: use this explicit set of possible states when it fits.
 *   Explicit-definition sessions are constrained to this definition; if none of its
 *   states fit, the selected state can be undefined and the runner can answer normally.
 */
export type TurnMode = "agent" | "auto" | StateMachineDefinition;

export type TurnRunnerTerminalStatus = "completed" | "failed" | "cancelled";

export type TurnStateStatus =
  | "running"
  | "waiting_for_human"
  | "sleeping"
  | "interrupted"
  | TurnRunnerTerminalStatus;

/** TurnRunner-owned state snapshot needed to continue a later turn. */
export interface TurnState {
  /** Lifecycle of the current turn state, regardless of agent or state-machine mode. */
  status: TurnStateStatus;
  /**
   * The mode originally used to start the session. This is required on resume so
   * "auto" sessions can keep creating definitions while explicit-definition sessions
   * stay constrained to their provided state set.
   */
  mode: TurnMode;
  /**
   * Effective runtime options for future turns. Persisted separately from agent
   * transcripts so model, memory model, and thinking level survive resume even
   * when process defaults change.
   */
  options?: TurnOptions;
  /** The agent conversation is always present, including state-machine sessions. */
  agent: AgentSession;
  /** Present when this session is executing in state-machine mode. */
  stateMachine?: StateMachineSession;
  /**
   * Current todo list written by the todo tool. Persisted with the turn state so
   * resumed runners preserve the same work plan instead of starting with an
   * empty tool-local list.
   */
  todos?: TurnTodo[];
  /**
   * User-visible follow-up prompts waiting to be delivered. The runner mirrors
   * this into pi-agent follow-up queues when a parent agent is active. Each
   * entry is a subset of `TurnPromptCommand` (its `message` and optional
   * `images`), persisted alongside state so resumed runners can replay the
   * same multimodal payload they would have delivered live.
   */
  followUpQueue?: TurnFollowUpQueueEntry[];
  /**
   * Commands accepted by the runner but not yet executed because active work
   * could not absorb them. These are replayed after resume in the original
   * order when the runner can safely continue.
   */
  queuedCommands?: TurnCommand[];
}

/**
 * How a follow-up prompt should be delivered while a pi session is active.
 *
 * - "steer": deliver as an interruption/steering message to the active pi agent.
 * - "follow_up": queue until the active pi agent finishes its current turn.
 */
export type TurnPromptBehavior = "steer" | "follow_up";

export interface TurnOptions {
  /** Model override for the user-visible agent turn, as shorthand or provider:modelId. */
  model?: string;
  /**
   * Model override for observational memory extraction and reflection, in
   * shorthand or provider:modelId format. When omitted, memory work uses the runner's
   * configured `memoryModel`, then the default memory model.
   */
  memoryModel?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface TurnQuestionOption {
  /** Display label shown to the user. */
  label: string;
  /** Optional extra context for the option. */
  description?: string;
}

export interface TurnQuestion {
  /** Question text shown to the user. */
  question: string;
  /** Optional section heading for grouped questions. */
  header?: string;
  /** Available answers. */
  options: TurnQuestionOption[];
  /** Whether multiple options can be selected. */
  multiSelect?: boolean;
}

export type TurnTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TurnTodo {
  /** Stable identifier used by todo edits to replace an existing work item. */
  id: string;
  /** Stable UI-facing label for the work item. */
  content: string;
  /** Current progress state for the work item. */
  status: TurnTodoStatus;
}

/** Token accounting mirrors pi's Usage shape so runner events can forward provider usage without renaming fields. */
export type TurnTokenUsage = Usage;

export type TurnStep =
  | {
      type: "text_delta";
      /** Partial assistant text streamed before the canonical `text` step arrives. */
      delta: string;
    }
  | {
      type: "reasoning_delta";
      /** Partial reasoning streamed before the canonical `reasoning` step arrives. */
      delta: string;
    }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      toolCallId: string;
      status: "pending" | "running" | "completed" | "error";
      /** Tool arguments as parsed by the model. Shape is tool-specific. */
      input?: Record<string, any>;
      /** Tool result content, present once the tool finishes (status "completed" or "error"). */
      output?: (TextContent | ImageContent)[];
    }
  | { type: "system"; message: string };

/**
 * HTTP MCP server configuration.
 *
 * The runner connects via the streamable-HTTP transport, lists the server's
 * tools at start, and exposes them to the agent under names of the form
 * `{server}__{tool}`. Authentication is intentionally out of scope: pass any
 * credentials the server expects through `headers`.
 */
export interface McpHttpServerConfig {
  /** Transport tag. Only `"http"` is supported today. */
  type: "http";
  /** Absolute http or https URL of the remote MCP endpoint. */
  url: string;
  /** Extra HTTP headers sent on every request to this server. */
  headers?: Record<string, string>;
}

/**
 * Set up a new turn-runner session.
 *
 * `start` is a setup command, not a turn. The runner loads memory and skills,
 * stores its initial `TurnState` (either fresh or the resumed one passed via
 * `state`), and emits `turn_started`. No agent work runs. The caller sends
 * `prompt` afterwards to actually run a turn. Skills, agent files, and skill
 * collisions are exposed through dedicated runner methods so callers can
 * render the setup summary without subscribing to a dedicated event.
 *
 * The CLI/TUI sends this on launch so the user sees the available skills
 * before typing the first prompt.
 */
export interface TurnStartCommand {
  type: "start";
  /** Routing mode for subsequent prompts. Omit to use the turn runner's configured default. */
  mode?: TurnMode;
  /**
   * Existing state to resume. When provided, the runner emits `turn_started`
   * with this state instead of creating a fresh one. Resumed sessions keep
   * their persisted agent and state-machine history.
   */
  state?: TurnState;
  /**
   * Session-scoped runtime options. These are fixed when the runner starts so
   * the parent pi-agent keeps a stable model, thinking level, and prompt cache
   * shape across every pi-agent turn inside later duet-agent turns.
   */
  options?: TurnOptions;
  /**
   * Remote MCP servers to connect to before the first turn runs. Each entry's
   * tools are exposed to the parent and state agents under namespaced names.
   * Connection failures are logged and skipped so a single broken server
   * cannot block session setup.
   */
  mcpServers?: Record<string, McpHttpServerConfig>;
}

/**
 * Image attachment carried alongside a prompt's text. The data is base64-encoded
 * raw image bytes (no `data:` URL prefix) and `mimeType` is the standard
 * `image/png`, `image/jpeg`, etc. label vision-capable models expect.
 *
 * Attachments are passed verbatim to the underlying agent as multimodal user
 * content; the surrounding `message` text remains the prompt's primary body.
 */
export interface TurnPromptImage {
  data: string;
  mimeType: string;
}

/**
 * Pending follow-up prompt waiting to be replayed against the parent agent.
 *
 * Shape is a subset of `TurnPromptCommand` (the user-facing prompt fields,
 * minus `behavior`, which is implicit — every queued entry runs as a
 * follow-up). Persisted with `TurnState.followUpQueue` so resumed sessions
 * deliver the same multimodal payload the original turn would have.
 */
export interface TurnFollowUpQueueEntry {
  message: string;
  images?: TurnPromptImage[];
}

/**
 * Send a new user prompt against the runner's current state.
 *
 * Callers may send prompt commands even while a previous `turn()` call is
 * active. The turn runner maps `behavior` onto the active pi agent when it can
 * and otherwise queues the command behind active non-agent work. State is held
 * inside the runner; it was bootstrapped at `start` and is updated from the
 * runner's own terminal events.
 */
export interface TurnPromptCommand {
  type: "prompt";
  message: string;
  /**
   * Delivery behavior for this user message. The runner decides whether the
   * parent pi-agent or state-machine work is currently driving the public
   * duet-agent turn; that driver determines whether this reaches pi immediately
   * or waits for state-transition context.
   */
  behavior: TurnPromptBehavior;
  /**
   * Optional image attachments delivered as multimodal content to the parent
   * pi-agent. Empty/undefined means a plain-text prompt; the previous behavior.
   */
  images?: TurnPromptImage[];
}

/**
 * Provide answers to a structured question emitted by the runner.
 *
 * Answers serialize into parent-agent prompt text and follow the same active
 * turn behavior as prompts. State-agent answers also route through the parent,
 * which can inspect state-machine history and select the appropriate state.
 */
export interface TurnAnswerCommand {
  type: "answer";
  questions: TurnQuestion[];
  /**
   * Selected option labels per question, keyed by `question.question`.
   * Always an array so single-select and multi-select share one shape; a
   * single-select answer is a one-element array, and an empty array means
   * the user advanced past a multi-select question without picking anything.
   */
  answers: Record<string, string[]>;
  /** Same delivery behavior as prompts after the answers are serialized. */
  behavior: TurnPromptBehavior;
  /**
   * Optional free-form prompt appended after the serialized answer XML.
   * Lets the user flush partial answers and a new instruction in one turn
   * when they decide to type instead of finishing the picker.
   */
  message?: string;
  /**
   * Optional image attachments delivered alongside the synthesized prompt,
   * matching `TurnPromptCommand.images` semantics.
   */
  images?: TurnPromptImage[];
}

/** Wake the runner's sleeping state. If the state is not waiting on scheduled work, this is a no-op. */
export interface TurnWakeCommand {
  type: "wake";
}

/**
 * Replace the currently visible follow-up queue.
 *
 * This is an out-of-band edit command for UI clients. It mirrors the queue into
 * the active pi agent when possible, but the protocol event is emitted from the
 * runner-owned prompt list so clients can render and edit it directly.
 */
export interface TurnEditFollowUpQueueCommand {
  type: "edit_follow_up_queue";
  /** Full replacement queue, in the order prompts should be delivered. */
  prompts: TurnFollowUpQueueEntry[];
}

/**
 * Commands that drive a single turn-runner turn. `start` is excluded because
 * setup is not a turn and is handled by `TurnRunner.start()` directly.
 */
export type TurnCommand = TurnPromptCommand | TurnAnswerCommand | TurnWakeCommand;

/** Out-of-band control message that interrupts the currently running turn. */
export interface TurnInterruptCommand {
  type: "interrupt";
}

export type TurnRunnerCommand =
  | TurnStartCommand
  | TurnCommand
  | TurnInterruptCommand
  | TurnEditFollowUpQueueCommand;

/** A system-prompt file that was resolved on disk for the session. */
export interface TurnAgentFile {
  /** Configured file name relative to the working directory, e.g. "AGENTS.md". */
  name: string;
  /** Absolute path on disk. */
  path: string;
}

export interface TurnStartedEvent {
  type: "turn_started";
  /** Full turn state after applying config/options/auto routing. */
  state: TurnState;
}

export interface TurnStepEvent {
  type: "step";
  step: TurnStep;
}

export interface TurnTodosEvent {
  type: "todos";
  todos: TurnTodo[];
}

export interface TurnFollowUpQueueEvent {
  type: "follow_up_queue";
  /** Prompts currently waiting to run as follow-ups after active work settles. */
  prompts: TurnFollowUpQueueEntry[];
}

export interface TurnStateMachineEvent {
  type: "state_machine";
  /** Display name of the current state. */
  currentState: string;
}

export interface TurnMemoryEvent extends ObservationalMemoryActivityEvent {
  type: "memory";
}

/**
 * Per-segment estimate of how many tokens currently occupy each region of
 * the parent agent's input. Distinct from `TurnTokenUsage`, which reports
 * the flat provider-side totals: this breakdown attributes the occupancy
 * to the segments the runner controls, so surfaces can show *which* part
 * of the budget is filling up. Values are heuristic character-length
 * estimates, not exact tokenizer counts.
 */
export interface TurnContextWindowUsage {
  /**
   * Tokens occupied by the parent agent's full system prompt, including
   * the base coding-agent prompt, any user-supplied `systemInstructions`,
   * and every system-prompt file loaded from disk (typically `AGENTS.md`).
   */
  systemPrompt: number;
  /**
   * Tokens occupied by the raw message history that will be sent on the
   * next turn. Includes the latest assistant response just appended to
   * state. Synthetic memory wrappers re-injected by the transform on each
   * request are not counted; they are transient.
   */
  messages: number;
  /**
   * Tokens occupied by the current session's local memory pack rendered
   * into the actor prefix. Sums the `content` field of every observation
   * and reflection in the frozen local pack.
   */
  localMemory: number;
  /**
   * Tokens occupied by the cross-session global memory pack rendered into
   * the actor prefix. Sums the `content` field of every observation and
   * reflection in the frozen global pack.
   */
  globalMemory: number;
}

export interface TurnContextUsageEvent {
  type: "context_usage";
  /** Token accounting reported by the parent model for the latest request context. */
  usage: TurnTokenUsage;
  /**
   * Effective ceiling against which `usage` should be displayed. Reflects
   * the user-set `TurnRunnerConfig.effectiveContext` (default 200k) clamped
   * to the model's hard context window. Every memory budget is derived from
   * this same value, so the bar also represents the practical compaction
   * ceiling.
   */
  effectiveContextWindow: number;
  /**
   * Segment-by-segment estimate of how the actor's input is allocated
   * across the system prompt, raw message history, and the two memory
   * pack layers. Lets surfaces visualize which budget is filling up
   * instead of only showing the aggregate provider-reported usage.
   */
  contextWindowUsage: TurnContextWindowUsage;
}

export interface TurnTerminalBaseEvent {
  state: TurnState;
  usage?: TurnTokenUsage;
}

export interface TurnAskEvent extends TurnTerminalBaseEvent {
  type: "ask";
  questions: TurnQuestion[];
}

export interface TurnCompletedEvent extends TurnTerminalBaseEvent {
  type: "complete";
  status: TurnRunnerTerminalStatus;
  result?: string;
  error?: string;
}

export interface TurnInterruptedEvent extends TurnTerminalBaseEvent {
  type: "interrupted";
}

export interface TurnSleepEvent extends TurnTerminalBaseEvent {
  type: "sleep";
  /** Unix timestamp in milliseconds when the outer layer should wake the runner. */
  wakeAt: number;
}

export interface TurnSystemEvent {
  type: "system";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Events emitted while the runner is still working on the current turn. */
export type TurnDuringEvent =
  | TurnStepEvent
  | TurnTodosEvent
  | TurnFollowUpQueueEvent
  | TurnStateMachineEvent
  | TurnMemoryEvent
  | TurnContextUsageEvent
  | TurnSystemEvent;

/** Events that end the current turn. */
export type TurnTerminalEvent =
  | TurnAskEvent
  | TurnCompletedEvent
  | TurnInterruptedEvent
  | TurnSleepEvent;

export type TurnEvent = TurnStartedEvent | TurnDuringEvent | TurnTerminalEvent;
