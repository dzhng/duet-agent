import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  getEnvApiKey,
  isContextOverflow,
  type ImageContent,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";

import { assistantText } from "../core/serializer.js";
import { toXML } from "../lib/xml.js";
import {
  createObservationalContextTransform,
  DEFAULT_EFFECTIVE_CONTEXT,
  estimateTokens,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
  updateObservationalMemory,
} from "../memory/observational.js";
import { rebuildMemoryContextPack } from "../memory/context-pack.js";
import { createEmbeddingClient } from "../memory/embedding.js";
import { loadStoredMemory, type MemoryPersistenceHandle } from "../memory/storage.js";
import { MemoryContextCache } from "../memory/store.js";
import {
  DEFAULT_CLI_MEMORY_MODEL,
  DEFAULT_CLI_MODEL,
  resolveModelName,
} from "../model-resolution/resolver.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnContextWindowUsage,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnEventOrigin,
  TurnFollowUpQueueEntry,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
  TurnPromptImage,
  TurnState,
  TurnTokenUsage,
  TurnStartCommand,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnTodo,
} from "../types/protocol.js";
import type { StateMachineAgentState } from "../types/state-machine.js";
import { agentEventToTurnEvents, agentMessageText } from "./agent-events.js";
import { createStateMachineSystemPromptLayer } from "./prompts.js";
import {
  applyEvictionHorizon,
  calculateWireBytes,
  createInitialHorizon,
  findEvictionHorizon,
  type WireGuardHorizon,
} from "./wire-shaping.js";
import {
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  formatCarriedTodosReminder,
  formatStateMachineTerminalAcknowledgmentPrompt,
  type RecallMemoryToolStorage,
  isTurnRunnerControlResult,
  type TurnRunnerControlResult,
} from "./tools.js";
import { connectMcpServers, type McpRuntime } from "./mcp.js";
import { SkillContext } from "./skill-context.js";
import { currentScheduledState, isWaitingOnScheduledState } from "./state-machine-session.js";
import {
  StateMachineController,
  type StateAgentHandle,
  type StateAgentResult,
  type StateMachineExecutionResult,
} from "./state-machine-controller.js";
import { completeTurn, copyOptionalArray, createInitialTurnState } from "./turn-state.js";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
  type TransientRetryPolicy,
} from "./transient-error.js";
import { addUsage, usageFromMessages } from "./usage-accounting.js";

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  /**
   * Optional image attachments forwarded to `agent.prompt(text, images)`.
   * Only the parent prompt path carries images; state-machine sub-agents and
   * answer commands ignore them because their prompts are runner-synthesized.
   */
  images?: ImageContent[];
}

export interface AgentConfigInput {
  state: TurnState;
  appendSystemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
}

/**
 * Internal outcome of a single `runAgentWorker` call. Narrower than the
 * public `TurnTerminalEvent`: a worker only produces `complete` or
 * `interrupted`. `ask` is synthesized later from `control`; `sleep` is
 * synthesized by the state-machine controller.
 */
export type AgentWorkerOutcome =
  | {
      type: "complete";
      status: "completed" | "failed";
      result?: string;
      error?: string;
      state: TurnState;
    }
  | { type: "interrupted"; state: TurnState };

export interface AgentWorkerResult {
  outcome: AgentWorkerOutcome;
  control: TurnRunnerControlResult;
  parentUsage?: TurnTokenUsage;
}

/** Order matches `TurnContextWindowUsage` fields; indexes map to `scaled[0..3]`. */
const CONTEXT_USAGE_KEYS = [
  "systemPrompt",
  "messages",
  "localMemory",
  "globalMemory",
] as const satisfies readonly (keyof TurnContextWindowUsage)[];

/**
 * Rescale the four segment estimates so they sum exactly to the
 * provider-reported `totalTokens` on the latest assistant message.
 * When `totalTokens` is at least the number of non-zero raw slices, each
 * such slice gets at least one token, then the rest is split by raw
 * weight with largest-remainder tie-breaks so the total is exact.
 * Otherwise proportional floors apply (some slices may be zero). When
 * every raw slice is zero, everything is attributed to `messages`.
 */
export function scaleContextWindowUsageToTotalTokens(
  base: TurnContextWindowUsage,
  totalTokens: number,
): TurnContextWindowUsage {
  const target = Math.max(0, Math.floor(totalTokens));
  if (target === 0) {
    return { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 };
  }

  const raw = CONTEXT_USAGE_KEYS.map((k) => Math.max(0, Math.floor(base[k])));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return { systemPrompt: 0, messages: target, localMemory: 0, globalMemory: 0 };
  }

  const minAlloc: number[] = raw.map((v) => (v > 0 ? 1 : 0));
  const minSum = minAlloc.reduce((a, b) => a + b, 0);

  let scaled: number[];
  if (target >= minSum && minSum > 0) {
    // Reserve one token per non-empty raw slice so tiny provider totals
    // do not wipe whole segments in the UI, then split the rest by weight.
    scaled = [...minAlloc];
    const remainderPool = target - minSum;
    if (remainderPool > 0) {
      const extra = raw.map((v) => Math.floor((v * remainderPool) / sum));
      for (let i = 0; i < 4; i++) scaled[i]! += extra[i]!;
      let remainder = remainderPool - extra.reduce((a, b) => a + b, 0);
      const fracs = raw.map((v, i) => ({
        i,
        frac: (v * remainderPool) / sum - extra[i]!,
      }));
      fracs.sort((a, b) => b.frac - a.frac);
      for (let r = 0; r < remainder; r++) {
        scaled[fracs[r]!.i]! += 1;
      }
    }
  } else {
    // Provider total smaller than the number of non-empty slices — fall
    // back to pure proportional floors (some segments may be zero).
    scaled = raw.map((v) => Math.floor((v * target) / sum));
    let remainder = target - scaled.reduce((a, b) => a + b, 0);
    const fracs = raw.map((v, i) => ({
      i,
      frac: (v * target) / sum - scaled[i]!,
    }));
    fracs.sort((a, b) => b.frac - a.frac);
    for (let r = 0; r < remainder; r++) {
      scaled[fracs[r]!.i]! += 1;
    }
  }

  return {
    systemPrompt: scaled[0]!,
    messages: scaled[1]!,
    localMemory: scaled[2]!,
    globalMemory: scaled[3]!,
  };
}

export class TurnRunner {
  private readonly eventHandlers = new Set<TurnEventHandler>();
  /** In-memory observation store used by context transforms during agent turns. */
  protected readonly memory = new MemoryContextCache();
  /** Hydrates, flushes, and disposes durable observation storage. */
  private memoryPersistence?: MemoryPersistenceHandle;
  /**
   * Session-scoped parent pi agent. It is created once during start() so model,
   * tools, and system prompt shape stay stable for prompt caching while the
   * transcript grows across every pi-agent turn in this duet-agent session.
   */
  private parentAgent?: Agent;
  /** True only while the parent pi agent is actively producing the public terminal event. */
  private parentAgentRunning = false;
  /** Last turn-runner control tool result observed from the parent agent. */
  private parentControlResult: TurnRunnerControlResult = { type: "none" };
  /** Runtime owner for state-machine progress and active state work. */
  private readonly stateMachineController: StateMachineController;
  /** Parent prompt started by a steer while state-machine work is driving the turn. */
  private activeStateWorkPrompt?: Promise<TurnTerminalEvent>;
  /** Terminal event prepared by `interrupt()` and returned when active work unwinds. */
  private interruptedTerminal?: TurnTerminalEvent;
  /**
   * Active work-chain promise. Callers may call turn() repeatedly while this is
   * set; those commands are folded into the same duet-agent turn. A duet-agent
   * turn may contain multiple parent pi-agent turns and multiple state-machine
   * transitions, but it emits one public terminal event for the whole chain.
   */
  private activeTurnPromise?: Promise<TurnTerminalEvent>;
  /** Latest runner-owned state, hydrated by start() and advanced by terminal events. */
  private state?: TurnState;
  /** True after `start()` has emitted the initial `turn_started` event. */
  private started = false;
  /** Aggregates model usage across parent agents, state agents, and memory work for one turn chain. */
  private turnUsage?: TurnTokenUsage;
  /**
   * Snapshot of the latest parent assistant `message_end`'s bar fields.
   * State-agent and terminal emissions reuse these so the bar/breakdown
   * does not jitter mid-turn when only a state agent advanced cost.
   *
   * Always set by the time a state agent runs in production: the parent
   * worker selects a state via a real LLM call, which emits `message_end`
   * and populates this. Exposed as `protected` for test harnesses that
   * stub `runAgentWorker` past the real parent path and need to seed the
   * snapshot before driving a state-agent emission.
   */
  protected lastParentUsageSnapshot?: {
    effectiveContextWindow: number;
    contextWindowUsage: TurnContextWindowUsage;
    lastMessageUsage: TurnTokenUsage;
  };
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
  /** MCP servers connected during start(). Disposed on runner.dispose(). */
  private mcpRuntime?: McpRuntime;
  protected readonly skillContext: SkillContext;

  constructor(readonly config: TurnRunnerConfig) {
    this.skillContext = new SkillContext(config);
    this.stateMachineController = new StateMachineController({
      cwd: config.cwd ?? process.cwd(),
      createStateAgent: (input) => this.createStateAgentHandle(input),
    });
  }

  async dispose(): Promise<void> {
    this.parentAgent?.clearAllQueues();
    this.activeStateWorkPrompt = undefined;
    this.setQueuedCommands([]);
    this.clearFollowUpQueue();
    await this.memoryPersistence?.dispose();
    this.memoryPersistence = undefined;
    await this.mcpRuntime?.dispose();
    this.mcpRuntime = undefined;
  }

  subscribe(handler: TurnEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.requireStarted();
    this.replaceFollowUpQueue(command.prompts);
  }

  /**
   * Set up a session before any turn runs. Loads memory and skills, then
   * emits `turn_started` with the initial state (a fresh state, or the
   * resumed state when `command.state` is provided). No agent work runs.
   *
   * Callers (CLI/TUI/session managers) call this once on launch so the user
   * sees available skills before typing the first prompt.
   */
  async start(command: TurnStartCommand): Promise<TurnState> {
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    await this.ensureMcpServersConnected(command.mcpServers);
    const mode = command.mode ?? this.config.mode ?? "auto";
    const startOptions = command.options;
    const state = command.state
      ? {
          ...command.state,
          options: this.resolveTurnOptions(startOptions, command.state.options),
        }
      : createInitialTurnState(mode, this.resolveTurnOptions(startOptions));
    this.stateMachineController.hydrate(state.stateMachine);
    this.setState(state);
    this.initializeParentAgent();
    this.started = true;
    const hydratedState = this.requireRunnerState();
    this.emit({ type: "turn_started", state: hydratedState });
    return hydratedState;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.requireStarted();
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    if (this.activeTurnPromise) {
      // turn() is the concurrency boundary: repeated calls extend or queue
      // behind the active chain instead of creating a separate parent transcript.
      this.handleCommandDuringActiveTurn(command);
      return this.activeTurnPromise;
    }

    const activeTurnPromise = this.runTurnChain(command);
    this.activeTurnPromise = activeTurnPromise;
    try {
      return await activeTurnPromise;
    } finally {
      if (this.activeTurnPromise === activeTurnPromise) {
        this.activeTurnPromise = undefined;
      }
    }
  }

  private async runTurnChain(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.turnUsage = undefined;
    try {
      let terminal: TurnTerminalEvent;
      terminal = await this.executeTurnCommand(command);
      terminal = await this.drainQueuedTurnCommands(terminal);
      terminal = { ...terminal, state: this.snapshotState(terminal.state) };
      if (this.turnUsage) {
        terminal = {
          ...terminal,
          turnUsage: this.turnUsage,
          ...(this.lastParentUsageSnapshot
            ? {
                effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
                contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
                lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
              }
            : {}),
        };
      }
      this.setState(terminal.state);
      this.emit(terminal);
      return terminal;
    } finally {
      this.turnUsage = undefined;
    }
  }

  private async executeTurnCommand(command: TurnCommand): Promise<TurnTerminalEvent> {
    switch (command.type) {
      case "prompt":
        return this.prompt(command);
      case "answer":
        return this.answer(command);
      case "wake":
        return this.wake();
    }
  }

  private handleCommandDuringActiveTurn(command: TurnCommand): void {
    if ((command.type === "prompt" || command.type === "answer") && this.parentAgentRunning) {
      // The parent pi-agent is currently driving the public terminal event, so
      // user input can go straight to pi using pi's native steer/follow-up queues.
      this.sendCommandToAgent(this.requireParentAgent(), command);
      return;
    }

    if (command.type === "prompt" || command.type === "answer") {
      const message = this.commandToUserMessage(command);
      if (this.stateMachineController.hasActiveWork()) {
        if (command.behavior === "follow_up") {
          // State-machine work is driving the terminal event. Follow-ups are
          // transition context, so replay them before the next state decision.
          this.enqueueTurnCommand(command);
          return;
        }
        this.startParentPromptDuringActiveStateWork(message, command);
        return;
      }
    }

    this.enqueueTurnCommand(command);
  }

  private sendCommandToAgent(agent: Agent, command: TurnPromptCommand | TurnAnswerCommand): void {
    const message = this.commandToUserMessage(command);
    const images = command.type === "prompt" ? command.images : undefined;
    const agentMessage = buildUserAgentMessage(message, images);
    if (command.behavior === "steer") {
      agent.steer(agentMessage);
    } else {
      this.appendFollowUpPrompt(message, images);
      agent.followUp(agentMessage);
    }
  }

  private startParentPromptDuringActiveStateWork(
    message: string,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): void {
    const prompt = this.runParentPromptDuringActiveStateWork(message, command);
    this.activeStateWorkPrompt = prompt;
    void prompt.finally(() => {
      if (this.activeStateWorkPrompt === prompt) this.activeStateWorkPrompt = undefined;
    });
  }

  private async runParentPromptDuringActiveStateWork(
    message: string,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): Promise<TurnTerminalEvent> {
    const prompt =
      command.behavior === "steer"
        ? dedent`
            <system-reminder>
            The user sent this as a steer message while state-machine work is running.
            If the state-machine should change course, call select_state_machine_state to restart the current state with updated input or choose a different state.
            </system-reminder>

            ${message}
          `
        : message;
    const terminal = await this.prompt({
      type: "prompt",
      message: prompt,
      behavior: command.behavior,
      images: command.type === "prompt" ? command.images : undefined,
    });
    this.setState(terminal.state);
    return terminal;
  }

  private async drainQueuedTurnCommands(terminal: TurnTerminalEvent): Promise<TurnTerminalEvent> {
    let latest = terminal;
    while (this.getQueuedCommands().length > 0) {
      if (
        latest.type === "sleep" &&
        this.getQueuedCommands().every((command) => this.isFollowUpQueueCommand(command))
      ) {
        return latest;
      }
      if (
        latest.type === "interrupted" ||
        (latest.type === "complete" && latest.status === "failed")
      ) {
        this.setQueuedCommands([]);
        this.clearFollowUpQueue();
        return latest;
      }
      const queued = this.shiftQueuedCommand();
      if (!queued) break;
      this.removeQueuedFollowUpPrompt(queued);
      this.setState({
        ...latest.state,
        followUpQueue: this.getFollowUpQueue(),
        queuedCommands: this.getQueuedCommands(),
      });
      latest = await this.executeTurnCommand(queued);
    }
    return latest;
  }

  private commandToUserMessage(command: TurnPromptCommand | TurnAnswerCommand): string {
    if (command.type === "prompt") {
      return this.skillContext.resolveSlashSkillPrompt(command.message);
    }

    const answerXml = toXML([{ questions: command.questions }, { answers: command.answers }]);
    const base = dedent`
      Here are my answers to your questions.

      ${answerXml}
    `;
    if (!command.message?.trim()) return base;
    return `${base}\n\n${this.skillContext.resolveSlashSkillPrompt(command.message)}`;
  }

  private enqueueTurnCommand(command: TurnCommand): void {
    if (
      (command.type === "prompt" || command.type === "answer") &&
      command.behavior === "follow_up"
    ) {
      this.appendFollowUpPrompt(this.commandToUserMessage(command), command.images);
    }
    this.setQueuedCommands([...this.getQueuedCommands(), command]);
  }

  private replaceFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    this.setFollowUpQueue(entries);
    this.parentAgent?.clearFollowUpQueue();
    for (const entry of this.getFollowUpQueue()) {
      this.parentAgent?.followUp(buildUserAgentMessage(entry.message, entry.images));
    }
    this.replaceQueuedFollowUpCommands(entries);
    this.emitFollowUpQueue();
  }

  private replaceQueuedFollowUpCommands(entries: TurnFollowUpQueueEntry[]): void {
    this.removeQueuedFollowUpCommands();
    if (!this.state || this.parentAgentRunning) return;
    this.setQueuedCommands([
      ...this.getQueuedCommands(),
      ...entries.map(
        (entry) =>
          ({
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          }) satisfies TurnPromptCommand,
      ),
    ]);
  }

  private removeQueuedFollowUpCommands(): void {
    this.setQueuedCommands(
      this.getQueuedCommands().filter((command) => !this.isFollowUpQueueCommand(command)),
    );
  }

  private isFollowUpQueueCommand(
    command: TurnCommand,
  ): command is TurnPromptCommand | TurnAnswerCommand {
    return (
      (command.type === "prompt" || command.type === "answer") && command.behavior === "follow_up"
    );
  }

  private appendFollowUpPrompt(message: string, images?: TurnPromptImage[]): void {
    const entry: TurnFollowUpQueueEntry =
      images && images.length > 0 ? { message, images } : { message };
    this.setFollowUpQueue([...this.getFollowUpQueue(), entry]);
    this.emitFollowUpQueue();
  }

  private removeQueuedFollowUpPrompt(command: TurnCommand): void {
    if (!this.isFollowUpQueueCommand(command)) return;
    this.removeFollowUpPrompt(this.commandToUserMessage(command));
  }

  /**
   * Drop the first queued entry whose `message` text matches. Pi-agent's
   * persisted transcript only retains the text portion of multimodal user
   * content, so the text is the canonical dedup key for both live and
   * replayed follow-ups.
   */
  private removeFollowUpPrompt(message: string): void {
    const entries = this.getFollowUpQueue();
    const index = entries.findIndex((entry) => entry.message === message);
    if (index === -1) return;
    this.setFollowUpQueue([...entries.slice(0, index), ...entries.slice(index + 1)]);
    this.emitFollowUpQueue();
  }

  private clearFollowUpQueue(): void {
    if (this.getFollowUpQueue().length === 0) return;
    this.setFollowUpQueue([]);
    this.emitFollowUpQueue();
  }

  private emitFollowUpQueue(): void {
    this.emit({ type: "follow_up_queue", prompts: this.getFollowUpQueue() });
  }

  interrupt(_command: TurnInterruptCommand): void {
    this.requireStarted();
    if (!this.state) return;
    const hadActiveControllerWork = this.stateMachineController.hasActiveWork();
    this.stateMachineController.interrupt("Interrupted");
    const interruptedState = this.snapshotState(this.state);
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {
        ...interruptedState,
        status: "interrupted",
        agent: { ...interruptedState.agent, status: "cancelled" },
      },
    };
    this.setState(terminal.state);
    if (this.parentAgentRunning || hadActiveControllerWork) {
      // The active turn emits this terminal event after agent.prompt() unwinds.
      // interrupt() only aborts out-of-band; it does not own turn completion.
      this.interruptedTerminal = terminal;
    }
    this.parentAgent?.abort();
    this.parentAgent?.clearAllQueues();
    this.activeStateWorkPrompt = undefined;
    this.setQueuedCommands([]);
    this.clearFollowUpQueue();
    this.parentAgentRunning = false;
  }

  protected emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private consumeInterruptedTerminal(): TurnTerminalEvent | undefined {
    const terminal = this.interruptedTerminal;
    this.interruptedTerminal = undefined;
    return terminal;
  }

  protected async prompt(command: TurnPromptCommand): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state: TurnState = { ...originalState, status: "running" };
    const resolvedPrompt = this.skillContext.resolveSlashSkillPrompt(command.message);
    const todoReminder = formatCarriedTodosReminder(state.todos);
    const prompt = todoReminder ? `${todoReminder}\n\n${resolvedPrompt}` : resolvedPrompt;
    const images = promptImagesToContent(command.images);
    let terminal: TurnTerminalEvent;
    if (state.mode === "agent") {
      terminal = await this.runAgentMode(state, prompt, images);
    } else {
      terminal = await this.runTurnRunnerAgentWithStateMachineTools({
        state,
        prompt,
        images,
        mode: state.mode,
      });
    }

    return this.restoreSleepAfterPromptIfNeeded(originalState, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = this.commandToUserMessage(command);
    return this.prompt({
      type: "prompt",
      message,
      behavior: command.behavior,
      images: command.images,
    });
  }

  protected async wake(): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state: TurnState = { ...originalState, status: "running" };

    if (originalState.status === "sleeping") {
      // Sleeping scheduled states already ended the previous duet-agent turn.
      // Wake starts a new state-machine-driven turn; normal prompts while
      // sleeping instead start parent-driven turns.
      const result = await this.stateMachineController.wake();
      if (result) return this.driveStateMachineResult(result, state);
    }

    return {
      type: "complete",
      status: "completed",
      state: originalState,
      result: "Nothing to wake.",
    };
  }

  private restoreSleepAfterPromptIfNeeded(
    originalState: TurnState,
    terminal: TurnTerminalEvent,
  ): TurnTerminalEvent {
    if (
      originalState.status !== "sleeping" ||
      terminal.type !== "complete" ||
      !isWaitingOnScheduledState(terminal.state.stateMachine)
    ) {
      return terminal;
    }

    if (terminal.status === "failed") {
      this.emit({
        type: "system",
        level: "error",
        message: terminal.error ?? terminal.result ?? "Prompt failed while waiting.",
      });
    }

    const state = currentScheduledState(terminal.state.stateMachine);
    const progress = state ? terminal.state.stateMachine?.progress?.states[state.name] : undefined;
    const wakeAt =
      progress?.nextWakeAt ??
      (state?.kind === "poll" ? Date.now() + state.intervalMs : (state?.wakeAt ?? Date.now()));
    return {
      type: "sleep",
      wakeAt,
      state: { ...terminal.state, status: "sleeping" },
    };
  }

  private controllerResultToTerminal(
    result: StateMachineExecutionResult,
    baseState = this.requireRunnerState(),
  ): TurnTerminalEvent {
    const state = this.snapshotState(baseState);
    switch (result.type) {
      case "state_completed":
        return completeTurn(state, "completed", JSON.stringify(result.output ?? null));
      case "ask":
        return {
          type: "ask",
          questions: result.questions,
          state: { ...state, status: "waiting_for_human" },
        };
      case "sleep":
        return { type: "sleep", wakeAt: result.wakeAt, state: { ...state, status: "sleeping" } };
      case "interrupted":
        return { type: "interrupted", state: { ...state, status: "interrupted" } };
      case "terminal":
        return completeTurn(state, result.status, result.result, result.error);
    }
  }

  private async driveStateMachineResult(
    result: StateMachineExecutionResult,
    baseState = this.requireRunnerState(),
  ): Promise<TurnTerminalEvent> {
    let next = result;
    let state = baseState;
    // The controller only executes states. TurnRunner owns the continuation
    // loop so queued follow-ups always update the parent transcript before the
    // parent chooses the next state.
    while (next.type === "state_completed") {
      state = this.requireRunnerState();
      const queued = await this.drainQueuedTurnCommands({
        type: "complete",
        status: "completed",
        state: this.snapshotState({ ...state, status: "running" }),
      });
      if (queued.type !== "complete" || queued.status !== "completed") return queued;
      this.setState(queued.state);
      state = queued.state;
      next = await this.selectNextStateAfterCompletion(next.stateName, next.output);
    }
    if (next.type === "interrupted" && this.activeStateWorkPrompt) {
      return this.activeStateWorkPrompt;
    }
    if (next.type === "terminal") {
      // Run the parent's terminal acknowledgment turn so the
      // state-machine outcome is propagated back to the parent.
      // `terminate: true` on the state-machine tools means the parent's
      // prompt loop ends right after it selects a terminal (or a state
      // that then errors at runtime) — without this pass the parent has
      // no transcript entry for the outcome, cannot summarize it to the
      // user, and cannot kick off a follow-up state machine in response.
      const acknowledged = await this.runStateMachineTerminalAcknowledgment();
      if (acknowledged) return acknowledged;
      state = this.requireRunnerState();
    }
    return this.controllerResultToTerminal(next, state);
  }

  /**
   * Re-prompt the parent agent once after a state-machine terminal.
   *
   * The flag is per-session, so a fresh state machine created during
   * the acknowledgment turn — which `createStateMachineSession` builds
   * as a brand-new session object — will run its own acknowledgment
   * when it terminates. The flag's only job is to prevent the same
   * session.terminal from being re-acknowledged, which would otherwise
   * happen if the parent (incorrectly) routes back into the controller
   * on the already-terminal session and the controller re-records a
   * terminal on it.
   *
   * Behavior:
   * - Builds the acknowledgment prompt via
   *   `formatStateMachineTerminalAcknowledgmentPrompt`. The prompt is
   *   neutral with respect to "decided vs runtime failure" — the
   *   parent's own transcript already shows whether it selected the
   *   terminal, and `status`/`reason` carry the rest of the framing.
   * - Runs one parent worker pass with full state-machine tool access
   *   so the parent can either reply in plain text or call
   *   `create_state_machine_definition` to start follow-up work.
   * - On interruption, surfaces an `interrupted` terminal event for
   *   the whole turn.
   * - When the parent's reply carries a control action, drives that
   *   control through the standard `driveStateMachineResult` path so
   *   any newly-created state machine runs end-to-end and itself
   *   produces a follow-up terminal (which also gets acknowledged via
   *   its own session).
   * - When the parent's reply is plain text, returns `undefined` so
   *   the caller renders the original terminal (preserving
   *   status/error/SM history) and the parent's natural-language
   *   summary lands on the transcript as the final assistant message.
   */
  private async runStateMachineTerminalAcknowledgment(): Promise<TurnTerminalEvent | undefined> {
    const session = this.stateMachineController.getSession();
    if (!session?.terminal || session.terminalAcknowledged) return undefined;
    this.stateMachineController.markTerminalAcknowledged();
    const sessionForPrompt = this.stateMachineController.getSession();
    if (!sessionForPrompt?.terminal) return undefined;
    const acknowledgmentPrompt = formatStateMachineTerminalAcknowledgmentPrompt({
      session: sessionForPrompt,
    });
    // `snapshotState` re-reads parentAgent messages directly, so this turn
    // state includes the parent's transcript through the terminal-selecting
    // tool call without a separate refresh step.
    const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
    const workerResult = await this.runAgentWorkerWithUsage({
      state: turnState,
      prompt: acknowledgmentPrompt,
      ...this.createTools(turnState.mode),
    });
    this.setState(workerResult.outcome.state);
    if (workerResult.outcome.type === "interrupted") {
      return { type: "interrupted", state: workerResult.outcome.state };
    }
    const followUp = await this.controllerResultFromWorkerResult(
      workerResult,
      workerResult.outcome.state,
    );
    if (followUp) return this.driveStateMachineResult(followUp, workerResult.outcome.state);
    return undefined;
  }

  private async selectNextStateAfterCompletion(
    stateName: string,
    output?: unknown,
  ): Promise<StateMachineExecutionResult> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? undefined
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;
      const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
      const workerResult = await this.runAgentWorkerWithUsage({
        state: turnState,
        prompt: dedent`
          The state "${stateName}" finished.

          ${toXML({
            state_completed: {
              output: output ?? null,
            },
          })}

          ${retryInstruction ?? ""}

          You must call the select_state_machine_state tool to choose the next state, terminal state, or failure outcome.
          Do not answer normally. Do not return text instead of calling the tool.
        `,
        ...this.createTools(turnState.mode),
      });
      this.setState(workerResult.outcome.state);
      const result = await this.controllerResultFromWorkerResult(
        workerResult,
        workerResult.outcome.state,
      );
      if (!result) {
        continue;
      }
      return result;
    }

    return {
      type: "terminal",
      status: "failed",
      error: "State completed, but the runner did not call select_state_machine_state.",
    };
  }

  protected createStateAgentHandle(input: {
    state: StateMachineAgentState;
    prompt: string;
  }): StateAgentHandle {
    let control: TurnRunnerControlResult = { type: "none" };
    const state: TurnState = {
      status: "running",
      mode: "agent",
      options: this.requireRunnerState().options,
      agent: { status: "running", messages: [] },
    };
    const agent = this.createAgent(
      {
        state,
        appendSystemPrompt: input.state.systemPrompt,
        skills: this.skillContext.resolveStateAgentSkills(input.state),
        // Per-state cwd lets one agent state operate on a different
        // repository or subdirectory than the parent runner without
        // mutating shared config.
        ...this.createTools("agent", input.state.cwd),
      },
      (result) => {
        control = result;
      },
    );
    let unsubscribe: (() => void) | undefined;
    const finish = (): StateAgentResult => {
      if (control.type === "ask_user_question") {
        return { type: "ask", questions: control.questions };
      }
      if (agent.state.errorMessage) {
        return { type: "failed", error: agent.state.errorMessage };
      }
      return { type: "complete", result: assistantText(agent.state.messages) };
    };

    const origin: TurnEventOrigin = {
      kind: "state_machine_agent",
      state: input.state.name,
    };
    return {
      prompt: async () => {
        unsubscribe = agent.subscribe((event) => this.emitAgentEvent(event, origin));
        try {
          await agent.prompt(input.prompt);
          await this.retryTransientServerErrors(agent);
          return finish();
        } catch (error) {
          if (this.consumeInterruptedTerminal()) return { type: "interrupted" };
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
          // Record state-agent usage on every exit path — success, error, or
          // interrupt — so partial work still flows into the turn aggregate
          // and ticks the sidebar cost via the emitted `usage` event.
          this.recordUsage(usageFromMessages(agent.state.messages));
          this.emitTurnUsage(origin);
          unsubscribe?.();
        }
      },
      interrupt: () => {
        agent.abort();
        agent.clearAllQueues();
        unsubscribe?.();
      },
      partialAssistantText: () => assistantText(agent.state.messages) || undefined,
    };
  }

  private requireRunnerState(): TurnState {
    if (!this.state) {
      throw new Error("Turn runner has not been started.");
    }
    return this.state;
  }

  getState(): TurnState | undefined {
    if (!this.state) return undefined;
    return this.snapshotState(this.state);
  }

  private snapshotState(state: TurnState): TurnState {
    const parentAgent = this.parentAgent
      ? {
          ...state.agent,
          status: state.agent.status,
          messages: this.parentAgent.state.messages,
        }
      : state.agent;
    return {
      ...state,
      agent: parentAgent,
      stateMachine: this.stateMachineController.getSession(),
      todos: copyOptionalArray(state.todos ?? this.state?.todos),
      followUpQueue: copyOptionalArray(state.followUpQueue ?? this.state?.followUpQueue),
      queuedCommands: copyOptionalArray(state.queuedCommands ?? this.state?.queuedCommands),
    };
  }

  private setState(state: TurnState): void {
    this.state = this.snapshotState(state);
  }

  private snapshotActiveAgentState(): void {
    if (!this.state) return;
    this.state = this.snapshotState(this.state);
  }

  private getFollowUpQueue(): TurnFollowUpQueueEntry[] {
    return [...(this.state?.followUpQueue ?? [])];
  }

  private setFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, followUpQueue: [...entries] });
  }

  private getQueuedCommands(): TurnCommand[] {
    return [...(this.state?.queuedCommands ?? [])];
  }

  private setQueuedCommands(commands: TurnCommand[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, queuedCommands: [...commands] });
  }

  private shiftQueuedCommand(): TurnCommand | undefined {
    const commands = this.getQueuedCommands();
    const [command, ...remaining] = commands;
    this.setQueuedCommands(remaining);
    return command;
  }

  private getTodos(): TurnTodo[] {
    return [...(this.state?.todos ?? [])];
  }

  private setTodos(todos: TurnTodo[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, todos: [...todos] });
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("Turn runner has not been started.");
    }
  }

  protected requireParentAgent(): Agent {
    if (!this.parentAgent) {
      throw new Error("Turn runner parent agent has not been initialized.");
    }
    return this.parentAgent;
  }

  private initializeParentAgent(): void {
    const state = this.requireRunnerState();
    // Append the state-machine routing guidance whenever the parent agent has
    // state-machine tools available. "auto" mode is the case that matters most:
    // the agent must decide between todo_write and create_state_machine_definition,
    // and without this layer the only signal is each tool's own description.
    const appendSystemPrompt =
      state.mode === "agent"
        ? undefined
        : createStateMachineSystemPromptLayer({ mode: state.mode, session: state });
    this.parentControlResult = { type: "none" };
    this.parentAgent = this.createAgent(
      {
        state,
        appendSystemPrompt,
        ...this.createTools(state.mode),
      },
      (result) => {
        this.parentControlResult = result;
      },
    );
    this.replayFollowUpQueueIntoAgent(this.parentAgent);
    this.snapshotActiveAgentState();
  }

  protected async runTurnRunnerAgentWithStateMachineTools(input: {
    state: TurnState;
    prompt: string;
    images?: ImageContent[];
    mode: Exclude<TurnMode, "agent">;
  }): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state: input.state,
      prompt: input.prompt,
      images: input.images,
    });

    const result = await this.controllerResultFromWorkerResult(workerResult, input.state);
    if (!result) return this.outcomeToTerminal(workerResult.outcome);
    return this.driveStateMachineResult(result, workerResult.outcome.state);
  }

  private async controllerResultFromWorkerResult(
    workerResult: AgentWorkerResult,
    state: TurnState,
  ): Promise<StateMachineExecutionResult | undefined> {
    if (workerResult.control.type === "none") return undefined;
    if (workerResult.control.type === "ask_user_question") {
      return { type: "ask", questions: workerResult.control.questions };
    }
    if (workerResult.control.type === "create_state_machine_definition") {
      if (
        this.stateMachineController.getSession() &&
        !this.stateMachineController.getSession()?.terminal
      ) {
        return {
          type: "terminal",
          status: "failed",
          error:
            "Cannot create a new state-machine definition while the current state machine is still active.",
        };
      }

      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      this.stateMachineController.startSession({
        prompt: workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
        definition: workerResult.control.definition,
        currentState: firstState,
      });
      this.emit({ type: "state_machine", currentState: firstState });
      return this.stateMachineController.runDecision({ kind: "run_state", state: firstState });
    }

    if (workerResult.control.type !== "select_state_machine_state") {
      return {
        type: "terminal",
        status: "failed",
        error: "Unsupported state-machine control result.",
      };
    }

    if (
      !this.stateMachineController.getSession() &&
      typeof state.mode === "object" &&
      workerResult.control.decision.kind !== "fail"
    ) {
      this.stateMachineController.startSession({
        prompt: workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
        definition: state.mode as Exclude<TurnMode, "agent" | "auto">,
        currentState: workerResult.control.decision.state,
      });
    }
    if (workerResult.control.decision.kind !== "fail") {
      this.emit({ type: "state_machine", currentState: workerResult.control.decision.state });
    }
    return this.stateMachineController.runDecision(workerResult.control.decision);
  }

  protected createTools(
    mode: TurnMode,
    cwdOverride?: string,
  ): {
    tools: AgentTool[];
  } {
    const cwd = cwdOverride ?? this.config.cwd ?? process.cwd();
    const todoStorage = {
      getTodos: () => this.getTodos(),
      setTodos: (todos: TurnTodo[]) => {
        this.setTodos(todos);
        this.emit({ type: "todos", todos });
      },
    };
    const skills = this.skillContext.getSkills();
    const mcpTools = this.mcpRuntime?.tools ?? [];
    const recallStorage: RecallMemoryToolStorage = {
      getDb: () => this.memoryPersistence?.db,
      embed: this.memoryPersistence?.embed,
      sessionId: this.config.sessionId,
      // Reuse the resolved memory model so recall_memory's optional
      // expand flag goes to the same cheap model the observer uses.
      expansionModel: this.resolveMemoryActorModel(undefined),
    };
    if (mode === "agent") {
      return {
        tools: [
          ...createDefaultTurnRunnerTools(cwd, todoStorage, skills, recallStorage),
          ...mcpTools,
        ],
      };
    }

    return {
      tools: [
        ...createTurnRunnerTools({
          cwd,
          mode,
          getDefinition: () => this.stateMachineController.getSession()?.definition,
          getStateMachine: () => this.stateMachineController.getSession(),
          getActiveStateOutput: () => this.stateMachineController.getActiveOutput(),
          todoStorage,
          skills,
          recallStorage,
        }),
        ...mcpTools,
      ],
    };
  }

  private replayFollowUpQueueIntoAgent(agent: Agent): void {
    for (const entry of this.getFollowUpQueue()) {
      agent.followUp(buildUserAgentMessage(entry.message, entry.images));
    }
  }

  protected async runAgentMode(
    state: TurnState,
    prompt: string,
    images?: ImageContent[],
  ): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state,
      prompt,
      images,
    });
    if (workerResult.control.type === "ask_user_question") {
      return this.askUserQuestion(workerResult.outcome.state, workerResult.control);
    }
    return this.outcomeToTerminal(workerResult.outcome);
  }

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (this.parentAgentRunning) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }

    const agent = this.requireParentAgent();
    this.parentControlResult = { type: "none" };
    const previousMessageCount = agent.state.messages.length;
    this.setParentAgentRunning(true);

    const unsubscribe = agent.subscribe((event) => this.emitParentAgentEvent(event));
    let interruptedDuringPrompt: TurnTerminalEvent | undefined;
    try {
      await agent.prompt(input.prompt, input.images);
      // Single-shot recovery: if the provider rejected the first attempt
      // with a context-overflow error, advance the sticky wire-shaping
      // horizon so the next send carries roughly the newer half of
      // history, then resume the same turn via `agent.continue()`.
      // Continuing (rather than re-prompting) keeps the existing user
      // message at the tail instead of appending a duplicate. A
      // still-too-big second attempt falls through as `failed` — no
      // further retries.
      if (this.tryRecoverFromContextOverflow(agent)) {
        await agent.continue();
      }
      await this.retryTransientServerErrors(agent);
    } catch (error) {
      interruptedDuringPrompt = this.consumeInterruptedTerminal();
      if (!interruptedDuringPrompt) {
        throw error;
      }
    } finally {
      unsubscribe();
      this.setParentAgentRunning(false);
    }

    const interrupted = interruptedDuringPrompt ?? this.consumeInterruptedTerminal();
    if (interrupted) {
      return {
        control: this.parentControlResult,
        outcome: { type: "interrupted", state: interrupted.state },
      };
    }

    const messages = agent.state.messages;
    const parentUsage = usageFromMessages(messages.slice(previousMessageCount));
    const status = agent.state.errorMessage ? "failed" : "completed";
    const live = this.state;
    const state = {
      ...input.state,
      status,
      agent: {
        ...input.state.agent,
        status,
        messages,
      },
      todos: live?.todos ?? input.state.todos,
      followUpQueue: live?.followUpQueue ?? input.state.followUpQueue,
      queuedCommands: live?.queuedCommands ?? input.state.queuedCommands,
    } satisfies TurnState;
    if (status === "completed") {
      await this.updateMemoryAfterAgentRun(messages, state.options);
    }

    return {
      control: this.parentControlResult,
      outcome: {
        type: "complete",
        status,
        state,
        result: assistantText(messages),
        error: agent.state.errorMessage,
      },
      parentUsage,
    };
  }

  private setParentAgentRunning(running: boolean): void {
    this.parentAgentRunning = running;
    this.snapshotActiveAgentState();
  }

  /**
   * Records the parent worker's per-call usage into the running turn
   * aggregate and emits a `usage` event so consumers see cost tick after
   * each parent agent boundary. Recording at the worker boundary (instead
   * of per `message_end`) keeps the same behavior when test harnesses
   * stub `runAgentWorker` and supply `parentUsage` directly without
   * running a real pi `Agent`.
   */
  private async runAgentWorkerWithUsage(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const result = await this.runAgentWorker(input);
    this.recordUsage(result.parentUsage);
    this.emitTurnUsage();
    return result;
  }

  /**
   * Inspect the most recent assistant message after a parent prompt and,
   * when it carries a provider context-overflow error, mutate the agent
   * state and the sticky `wireGuardHorizon` so that a subsequent re-prompt
   * sends roughly the newer half of observable history.
   *
   * Returns `true` only when recovery actually happened — meaning the
   * horizon advanced past at least one observable message. Callers use
   * the return value as a single-shot gate: invoke once after the first
   * `agent.prompt(...)` and, on `true`, resume the turn via
   * `agent.continue()` exactly once. The helper never inspects the
   * failing message again, so a second overflow on the retry falls
   * through naturally as a `failed` turn.
   *
   * Mutations on success:
   * - pops the failure assistant message that pi-agent pushed for the
   *   overflow (an empty-text marker with `stopReason: "error"` and
   *   `errorMessage`) so the retry's transcript does not carry it.
   *   `agent.continue()`'s own run lifecycle resets `errorMessage`
   *   before the retry, so we do not clear it here;
   * - advances `this.wireGuardHorizon.evictionHorizon` to the smallest
   *   value at which `findEvictionHorizon` reports the dispatched list
   *   shrinks to at most `floor(n / 2)` observable messages, where `n`
   *   excludes the failure message itself.
   *
   * Emits one informational `system` event describing the compaction so
   * surfaces can show a notice. The message reports the *actual*
   * post-eviction drop count (after `MIN_HISTORY_TAIL` clamping and
   * orphan-head skipping), not the half-of-n target.
   *
   * Returns `false` when:
   * - the parent agent did not fail (`errorMessage` is unset);
   * - the failure is not a context overflow (rate limit, transport
   *   error, etc. — left as-is for the caller to surface);
   * - no horizon advance is possible (e.g. the existing horizon already
   *   covers every evictable message, or the history is too short to
   *   satisfy `MIN_HISTORY_TAIL`). In those cases retrying with the
   *   same context would still overflow, so we accept the failure
   *   instead of paying a second pointless request.
   */
  protected tryRecoverFromContextOverflow(agent: Agent): boolean {
    if (!agent.state.errorMessage) return false;
    const messages = agent.state.messages;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    if (!isContextOverflow(lastMessage, agent.state.model.contextWindow)) return false;

    // Exclude the failure assistant message from the half-history
    // calculation; only "real" prior turns should count toward the
    // observable population the cut targets.
    const observable = stripObservationalContextMessages(messages.slice(0, -1));
    const target = Math.floor(observable.length / 2);
    const previousHorizon = this.wireGuardHorizon.evictionHorizon;
    const newHorizon = findEvictionHorizon(
      observable,
      previousHorizon,
      (candidate) => candidate.length <= target,
    );
    if (newHorizon === previousHorizon) return false;

    messages.pop();
    this.wireGuardHorizon.evictionHorizon = newHorizon;

    const remaining = applyEvictionHorizon(observable, newHorizon).length;
    const dropped = observable.length - remaining;
    this.emit({
      type: "system",
      level: "info",
      message: `Context overflow: dropped ${dropped} older message${dropped === 1 ? "" : "s"} and retrying.`,
    });
    return true;
  }

  /**
   * Retry transient upstream failures by popping the failed assistant
   * message and continuing the same turn.
   *
   * Triggers only when the last assistant message has `stopReason: "error"`
   * and the error text matches a known gateway 5xx or transport-fault
   * pattern (see `transient-error.ts`). Context-overflow recoveries already
   * ran upstream and are skipped here; 4xx errors and rate limits are
   * intentionally not retried because the same payload would fail again.
   *
   * Each `agent.continue()` retry runs with exponential backoff + jitter.
   * Each retry emits an informational `system` event so callers can show
   * "retrying after upstream error" in the UI. The retry counter resets
   * whenever the agent makes forward progress between failures — if
   * `agent.continue()` appends a successful intermediate message before
   * the next failure tail, the next failure is treated as a fresh
   * sequence and gets the full retry budget. As soon as the assistant
   * message after a retry is no longer a transient failure (success or
   * a different non-retryable error), the helper returns and lets the
   * caller surface that outcome.
   *
   * The loop has no explicit iteration cap because every iteration
   * either reaches `maxAttempts` with no progress (terminates) or
   * resets after real agent work (tool calls, tokens, bounded by
   * pi-agent's own per-turn limits). A provider that can sustain
   * infinite "progress + failure" cycles would already be billing the
   * caller for real work each cycle — there is no free loop here.
   */
  protected async retryTransientServerErrors(
    agent: Agent,
    policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY_POLICY,
  ): Promise<void> {
    let attempt = 1;
    while (attempt < policy.maxAttempts) {
      if (!agent.state.errorMessage) return;
      if (!lastMessageIsTransientFailure(agent.state.messages)) return;
      const failingMessage = agent.state.messages.at(-1);
      const reason =
        failingMessage?.role === "assistant" && failingMessage.errorMessage
          ? failingMessage.errorMessage
          : "Upstream error";
      const delayMs = transientRetryDelayMs(attempt, policy);
      this.emit({
        type: "system",
        level: "info",
        message: `Upstream error (${truncateForSystemMessage(reason)}); retrying in ${Math.round(delayMs / 100) / 10}s (attempt ${attempt + 1}/${policy.maxAttempts}).`,
      });
      // pi-agent leaves the failure as the tail assistant message and
      // keeps `errorMessage` set; popping it lets `agent.continue()`
      // resume from the prior user/tool-result tail without sending the
      // failure marker back to the provider.
      agent.state.messages.pop();
      const lengthBeforeContinue = agent.state.messages.length;
      await sleep(delayMs);
      await agent.continue();
      // If `continue()` appended more than just a new failure tail
      // (i.e. at least one intermediate assistant or tool message
      // landed before the agent failed again), the agent made real
      // progress between failures. Reset so the next failure gets a
      // fresh retry budget instead of inheriting the running count.
      const messagesAppended = agent.state.messages.length - lengthBeforeContinue;
      attempt = messagesAppended > 1 ? 1 : attempt + 1;
    }
  }

  protected async updateMemoryAfterAgentRun(
    messages: AgentMessage[],
    options: TurnOptions | undefined,
  ): Promise<void> {
    if (this.config.memoryDbPath === undefined) {
      return;
    }
    const db = this.memoryPersistence?.db;
    if (!db) return;
    const result = await updateObservationalMemory({
      db,
      memory: this.memory,
      sessionId: this.config.sessionId,
      effectiveContext: this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      actorModel: this.resolveMemoryActorModel(options),
      settings: this.config.memory,
      messages,
      onUsage: (usage) => this.recordUsage(usage),
      onActivity: (event) => this.emit({ type: "memory", ...event }),
    });

    // Compaction trigger: a reflection just replaced the durable
    // observation set, so rebuild the frozen context pack to pick up
    // the new condensed view. Observer-only updates intentionally do
    // NOT refresh the pack — they leave the rendered prefix stable so
    // the provider's prompt cache survives.
    if (result.reflections.length > 0) {
      await this.refreshMemoryContextPack();
    }
  }

  private async refreshMemoryContextPack(): Promise<void> {
    if (!this.memoryPersistence?.db) return;
    try {
      await rebuildMemoryContextPack({
        db: this.memoryPersistence.db,
        cache: this.memory,
        settings: resolveObservationalMemorySettings(
          this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
          this.config.memory,
        ),
        ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
      });
    } catch {
      // Pack rebuild is best-effort; the existing pack remains in
      // place if this fails. Turn flow never blocks on memory work.
    }
  }

  /**
   * Memory model precedence: per-turn override → runner config → default.
   * Exposed as a method so tests can verify the exact fallback chain that the
   * memory observer ends up using.
   */
  resolveMemoryActorModel(options: TurnOptions | undefined): string {
    return options?.memoryModel ?? this.config.memoryModel ?? DEFAULT_CLI_MEMORY_MODEL;
  }

  protected createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const options = this.resolveTurnOptions(undefined, input.state.options);
    const model = resolveModelName(options.model ?? DEFAULT_CLI_MODEL);
    // Parent agent configuration is derived from start/session options, not
    // per-prompt command options. Keeping model and prompt shape stable protects
    // prompt caching across all pi-agent turns inside a duet-agent session.
    return new Agent({
      initialState: {
        model,
        thinkingLevel: options.thinkingLevel ?? "medium",
        systemPrompt: this.createBaseSystemPromptWithAppendedLayers({
          append: [input.appendSystemPrompt],
          skills: input.skills,
        }),
        messages: input.state.agent.messages,
        tools: input.tools,
      },
      transformContext: this.createMemoryTransform(),
      toolExecution: "parallel",
      afterToolCall: async (context) => {
        const details = context.result.details;
        if (isTurnRunnerControlResult(details)) {
          onControlResult?.(details);
        }
        return undefined;
      },
      getApiKey: getEnvApiKey,
    });
  }

  protected createMemoryTransform() {
    // The memory transform owns history retention against both the token
    // budget (context-window cost on smaller models) and the wire-byte
    // budget (gateway request-body caps). It applies the sticky horizon
    // first so subsequent turns reuse the same eviction decision and the
    // provider prompt cache stays valid between eviction events.
    return createObservationalContextTransform({
      memory: this.memory,
      effectiveContext: this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      settings: this.config.memory,
      horizon: this.wireGuardHorizon,
      // Compaction trigger #3: when wire-shaping advances the eviction
      // horizon the prompt cache is already invalidating, so refresh
      // the frozen memory pack at the same moment to piggyback the
      // cache miss instead of paying it twice.
      onCompaction: () => {
        void this.refreshMemoryContextPack();
      },
    });
  }

  // Sticky across all turns within this runner instance. Resets on
  // session resume (new runner). Mutated in place by the memory transform
  // when either the token or byte budget triggers eviction, and by
  // `runAgentWorker` on a provider context-overflow error so the retry
  // sends the newer half of history.
  protected readonly wireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkills();
  }

  /** System-prompt files (AGENTS.md by default) that resolved on disk for this session. */
  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getResolvedAgentFiles();
  }

  /** Skill name collisions where one definition shadowed another during discovery. */
  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkillCollisions();
  }

  getSkillInstructions(skillId: string): string {
    return this.skillContext.getSkillInstructions(skillId);
  }

  private async ensureSkillsLoaded(): Promise<void> {
    await this.skillContext.ensureLoaded();
  }

  /**
   * Connect to remote MCP servers exactly once per session. Subsequent starts
   * (e.g. resumed sessions) reuse the existing runtime so tool identity stays
   * stable. The runtime is disposed in dispose().
   */
  private async ensureMcpServersConnected(servers: TurnStartCommand["mcpServers"]): Promise<void> {
    if (this.mcpRuntime || !servers || Object.keys(servers).length === 0) return;
    this.mcpRuntime = await connectMcpServers(servers);
  }

  private async ensureMemoryLoaded(): Promise<void> {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;

    // Embedding client is built once per runner so connection reuse
    // amortizes TLS setup across both the backfill worker and the
    // recall_memory tool. The client lazily resolves DUET_API_KEY per
    // call so a `duet login` mid-session lights up retrieval without
    // a runner restart.
    //
    // Initial context pack build runs synchronously inside
    // loadStoredMemory so the very first dispatched turn already sees
    // a frozen memory prefix. Subsequent compaction triggers (reflector
    // completion, wire-shaping eviction) refresh it.
    this.memoryPersistence = await loadStoredMemory(
      this.config.memoryDbPath,
      this.config.cwd ?? process.cwd(),
      {
        embed: createEmbeddingClient(),
        contextPack: {
          cache: this.memory,
          settings: resolveObservationalMemorySettings(
            this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
            this.config.memory,
          ),
          ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
        },
        // Surface quarantine recoveries to the UI. The directory is moved
        // aside on the user's disk and a fresh database is opened in its
        // place, so prior memories are gone from this session's recall
        // until the user manually inspects the backup — without a system
        // event the loss is silent.
        onRecover: ({ backupPath, cause }) => {
          const reason = cause instanceof Error ? cause.message || cause.name : String(cause);
          this.emit({
            type: "system",
            level: "warn",
            message: `memory.db could not be opened (${reason}); quarantined to ${backupPath} and starting fresh.`,
          });
        },
      },
    );
  }

  protected createBaseSystemPromptWithAppendedLayers(input?: {
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return this.skillContext.createSystemPromptWithAppendedLayers(input);
  }

  private askUserQuestion(
    state: TurnState,
    control: Extract<TurnRunnerControlResult, { type: "ask_user_question" }>,
  ): TurnTerminalEvent {
    return {
      type: "ask",
      questions: control.questions,
      state: { ...state, status: "waiting_for_human" },
    };
  }

  /**
   * Lifts the internal `AgentWorkerOutcome` shape into the public
   * `TurnTerminalEvent` shape returned by `runTurnChain`. `runTurnChain`
   * attaches `usage` / `effectiveContextWindow` / `contextWindowUsage`
   * at the chain boundary, so this conversion intentionally omits them.
   */
  private outcomeToTerminal(outcome: AgentWorkerOutcome): TurnTerminalEvent {
    if (outcome.type === "interrupted") {
      return { type: "interrupted", state: outcome.state };
    }
    return {
      type: "complete",
      status: outcome.status,
      state: outcome.state,
      result: outcome.result,
      error: outcome.error,
    };
  }

  /**
   * Single source of truth for per-turn option precedence:
   * explicit turn options → carried-over state base → runner config → defaults.
   */
  resolveTurnOptions(options?: TurnOptions, base?: TurnOptions): TurnOptions {
    return {
      model: options?.model ?? base?.model ?? this.config.model ?? DEFAULT_CLI_MODEL,
      memoryModel:
        options?.memoryModel ??
        base?.memoryModel ??
        this.config.memoryModel ??
        DEFAULT_CLI_MEMORY_MODEL,
      thinkingLevel: options?.thinkingLevel ?? base?.thinkingLevel ?? this.config.thinkingLevel,
    };
  }

  protected recordUsage(usage?: TurnTokenUsage | Usage): void {
    this.turnUsage = addUsage(this.turnUsage, usage);
  }

  protected emitAgentEvent(event: AgentEvent, origin?: TurnEventOrigin): void {
    if (event.type === "message_start" && event.message.role === "user") {
      this.removeFollowUpPrompt(agentMessageText(event.message));
    }
    for (const turnEvent of agentEventToTurnEvents(event)) {
      this.emit(origin ? { ...turnEvent, origin } : turnEvent);
    }
  }

  protected emitParentAgentEvent(event: AgentEvent): void {
    this.emitAgentEvent(event);
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    // Cache the parent's latest bar/breakdown so subsequent state-agent and
    // terminal emissions can reuse it without rescaling against a stale base.
    // Usage *recording* and `usage` event emission happen at worker / state-agent
    // boundaries (see `runAgentWorkerWithUsage` and `createStateAgentHandle`)
    // instead of per message, so test harnesses that stub `runAgentWorker`
    // — without ever firing `message_end` — still get correct accounting.
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: this.effectiveContextWindow(),
      contextWindowUsage: scaleContextWindowUsageToTotalTokens(
        this.estimateContextWindowUsage(),
        event.message.usage.totalTokens,
      ),
      lastMessageUsage: event.message.usage,
    };
  }

  /**
   * Emit a `usage` event reflecting the latest `this.turnUsage`. Reuses the
   * most recent parent context-window snapshot for the bar/breakdown so
   * mid-turn ticks (parent worker finish, state-agent finish) surface cost
   * without jittering the parent context fields. No-ops when no usage has
   * been recorded yet or before the first parent emission — both are only
   * possible during construction/teardown or in test harnesses; a real
   * parent worker always sets the snapshot before its terminal usage is
   * recorded.
   */
  protected emitTurnUsage(origin?: TurnEventOrigin): void {
    if (!this.turnUsage || !this.lastParentUsageSnapshot) return;
    this.emit({
      type: "usage",
      turnUsage: this.turnUsage,
      lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
      ...(origin ? { origin } : {}),
    });
  }

  /**
   * Estimate the per-segment occupancy of the parent agent's input before
   * reconciliation with provider `totalTokens`. System prompt and memory
   * packs use the same `ceil(chars/4)` heuristic as the memory pipeline so
   * compaction triggers stay on the same scale as `MEMORY_BUDGET_RATIOS`.
   *
   * The message tail uses {@link calculateWireBytes} over the
   * post-eviction slice — the same slice the provider tokenized — so
   * messages already dropped by wire-shaping stop counting against the
   * `messages` segment instead of inflating it from the runner's full
   * retained transcript. Text and image blocks match the eviction guard,
   * and structured blocks (`toolCall`, thinking, etc.) contribute a
   * `JSON.stringify` length like the serialized request body.
   *
   * `emitParentAgentEvent` rescales all four segments with
   * {@link scaleContextWindowUsageToTotalTokens} so the emitted breakdown
   * sums exactly to the API-reported `usage.totalTokens`.
   */
  protected estimateContextWindowUsage() {
    const agent = this.requireParentAgent();
    const pack = this.memory.getContextPack();
    const dispatched = applyEvictionHorizon(
      agent.state.messages,
      this.wireGuardHorizon.evictionHorizon,
    );
    const messageWireTokens = Math.max(0, Math.ceil(calculateWireBytes(dispatched) / 4));
    return {
      systemPrompt: estimateTokens(agent.state.systemPrompt),
      messages: messageWireTokens,
      localMemory: pack.local.reduce((total, row) => total + estimateTokens(row.content), 0),
      globalMemory: pack.global.reduce((total, row) => total + estimateTokens(row.content), 0),
    };
  }

  /**
   * Effective ceiling for the context-usage bar. The user-set
   * `config.effectiveContext` (default `DEFAULT_EFFECTIVE_CONTEXT`) is clamped
   * to the parent model's hard window so a user asking for more than the
   * model can fit silently caps at the model's limit. Every memory budget is
   * derived from this same number, so the bar is also the practical
   * compaction ceiling.
   */
  protected effectiveContextWindow(): number {
    const modelWindow = this.requireParentAgent().state.model.contextWindow;
    return this.resolveEffectiveContext(modelWindow);
  }

  /**
   * Resolve the user-set `effectiveContext` against an optional model window.
   * Memory-pipeline callers that run before the parent agent exists (initial
   * pack load, transform construction) pass `undefined` here and accept the
   * unclamped user value; the agent-facing `effectiveContextWindow()` always
   * passes the live model window.
   */
  protected resolveEffectiveContext(modelWindow?: number): number {
    const userValue = this.config.effectiveContext ?? DEFAULT_EFFECTIVE_CONTEXT;
    return modelWindow !== undefined ? Math.min(userValue, modelWindow) : userValue;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap an upstream-error excerpt to a short, single-line form before emitting
 * it as a `system` info message. Provider error payloads can be several
 * kilobytes of JSON; clipping keeps the retry notice readable.
 */
function truncateForSystemMessage(message: string, limit = 160): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  if (flattened.length <= limit) return flattened;
  return `${flattened.slice(0, limit - 1)}…`;
}

/** Convert protocol-level prompt images into pi-ai `ImageContent` blocks. */
function promptImagesToContent(images: TurnPromptImage[] | undefined): ImageContent[] {
  if (!images) return [];
  return images.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mimeType,
  }));
}

/**
 * Build a pi-agent user message from a prompt's text and optional images.
 * Plain-text prompts use the simple string-content shape; multimodal prompts
 * become a content array with the text part first and image blocks after.
 */
function buildUserAgentMessage(
  message: string,
  images: TurnPromptImage[] | undefined,
): {
  role: "user";
  content: string | ({ type: "text"; text: string } | ImageContent)[];
  timestamp: number;
} {
  const imageContent = promptImagesToContent(images);
  const content =
    imageContent.length > 0 ? [{ type: "text" as const, text: message }, ...imageContent] : message;
  return { role: "user", content, timestamp: Date.now() };
}
