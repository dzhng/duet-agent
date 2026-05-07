import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model, type Usage } from "@mariozechner/pi-ai";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";

import { assistantText } from "../core/serializer.js";
import { isDuetGatewayModelName, resolveDuetGatewayModel } from "../duet-gateway/index.js";
import { toXML } from "../lib/xml.js";
import { createObservationalMemoryTransform } from "../memory/observational.js";
import { loadStoredMemory } from "../memory/storage.js";
import { MemoryStore } from "../memory/store.js";
import { DEFAULT_CLI_MEMORY_MODEL, DEFAULT_CLI_MODEL } from "../model-resolution/index.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
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
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  isTurnRunnerControlResult,
  type TurnRunnerControlResult,
} from "./tools.js";
import { SkillContext } from "./skill-context.js";
import { currentPollState, isWaitingOnPoll } from "./state-machine-session.js";
import {
  StateMachineController,
  type StateAgentHandle,
  type StateAgentResult,
  type StateMachineExecutionResult,
} from "./state-machine-controller.js";
import { completeTurn, copyOptionalArray, createInitialTurnState } from "./turn-state.js";
import { addUsage, usageFromMessages } from "./usage-accounting.js";

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  appendSystemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
}

export interface AgentWorkerResult {
  terminal: TurnTerminalEvent;
  control: TurnRunnerControlResult;
}

export class TurnRunner {
  private readonly eventHandlers = new Set<TurnEventHandler>();
  /** In-memory observation store used by context transforms during agent turns. */
  protected readonly memory = new MemoryStore();
  /** Stops memory persistence subscriptions/databases when the runner is disposed. */
  private memoryDispose?: () => Promise<void>;
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
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
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
    this.setQueuedCommands([]);
    this.clearFollowUpQueue();
    await this.memoryDispose?.();
    this.memoryDispose = undefined;
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
        terminal = { ...terminal, usage: this.turnUsage };
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
      if (this.stateMachineController.hasActiveStateAgent()) {
        if (command.behavior === "follow_up") {
          // State-machine work is driving the terminal event. Follow-ups are
          // transition context, so replay them before the next state decision.
          this.enqueueTurnCommand(command);
          return;
        }
        void this.runParentPromptDuringActiveStateWork(message, command);
        return;
      }

      if (this.stateMachineController.hasActiveWork()) {
        if (command.behavior === "follow_up") {
          // Active script/poll work follows the same rule as agent states:
          // steer can update the parent immediately, follow-up waits for the
          // next transition decision.
          this.enqueueTurnCommand(command);
          return;
        }
        void this.runParentPromptDuringActiveStateWork(message, command);
        return;
      }
    }

    this.enqueueTurnCommand(command);
  }

  private sendCommandToAgent(agent: Agent, command: TurnPromptCommand | TurnAnswerCommand): void {
    const message = this.commandToUserMessage(command);
    const agentMessage = { role: "user" as const, content: message, timestamp: Date.now() };
    if (command.behavior === "steer") {
      agent.steer(agentMessage);
    } else {
      this.appendFollowUpPrompt(message);
      agent.followUp(agentMessage);
    }
  }

  private async runParentPromptDuringActiveStateWork(
    message: string,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): Promise<StateMachineExecutionResult> {
    const prompt =
      command.behavior === "steer"
        ? dedent`
            The user sent this as a steer message while state-machine work is running.
            If the state-machine should change course, call select_state_machine_state to restart the current state with updated input or choose a different state.

            ${message}
          `
        : message;
    const terminal = await this.prompt({
      type: "prompt",
      message: prompt,
      behavior: command.behavior,
    });
    this.setState(terminal.state);
    const result = this.controllerResultFromTerminal(terminal);
    if (result.type === "state_completed") {
      await this.driveStateMachineResult(result, terminal.state);
    }
    return result;
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

    return dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;
  }

  private enqueueTurnCommand(command: TurnCommand): void {
    if (
      (command.type === "prompt" || command.type === "answer") &&
      command.behavior === "follow_up"
    ) {
      this.appendFollowUpPrompt(this.commandToUserMessage(command));
    }
    this.setQueuedCommands([...this.getQueuedCommands(), command]);
  }

  private replaceFollowUpQueue(prompts: string[]): void {
    this.setFollowUpQueue(prompts);
    this.parentAgent?.clearFollowUpQueue();
    for (const prompt of this.getFollowUpQueue()) {
      this.parentAgent?.followUp({
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      });
    }
    this.replaceQueuedFollowUpCommands(prompts);
    this.emitFollowUpQueue();
  }

  private replaceQueuedFollowUpCommands(prompts: string[]): void {
    this.removeQueuedFollowUpCommands();
    if (!this.state || this.parentAgentRunning) return;
    this.setQueuedCommands([
      ...this.getQueuedCommands(),
      ...prompts.map(
        (prompt) =>
          ({
            type: "prompt",
            message: prompt,
            behavior: "follow_up",
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

  private appendFollowUpPrompt(prompt: string): void {
    this.setFollowUpQueue([...this.getFollowUpQueue(), prompt]);
    this.emitFollowUpQueue();
  }

  private removeQueuedFollowUpPrompt(command: TurnCommand): void {
    if (!this.isFollowUpQueueCommand(command)) return;
    this.removeFollowUpPrompt(this.commandToUserMessage(command));
  }

  private removeFollowUpPrompt(prompt: string): void {
    const prompts = this.getFollowUpQueue();
    const index = prompts.indexOf(prompt);
    if (index === -1) return;
    this.setFollowUpQueue([...prompts.slice(0, index), ...prompts.slice(index + 1)]);
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
    const prompt = this.skillContext.resolveSlashSkillPrompt(command.message);
    let terminal: TurnTerminalEvent;
    if (state.mode === "agent") {
      terminal = await this.runAgentMode(state, prompt);
    } else {
      terminal = await this.runTurnRunnerAgentWithStateMachineTools({
        state,
        prompt,
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
    });
  }

  protected async wake(): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state: TurnState = { ...originalState, status: "running" };

    if (originalState.status === "sleeping") {
      // A sleeping poll already ended the previous duet-agent turn. Wake starts
      // a new state-machine-driven turn for one poll attempt; normal prompts
      // while sleeping instead start parent-driven turns.
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
      !isWaitingOnPoll(terminal.state.stateMachine)
    ) {
      return terminal;
    }

    if (terminal.status === "failed") {
      this.emit({
        type: "system",
        level: "error",
        message: terminal.error ?? terminal.result ?? "Prompt failed while waiting on poll.",
      });
    }

    const state = currentPollState(terminal.state.stateMachine);
    return {
      type: "sleep",
      wakeAt: Date.now() + (state?.intervalMs ?? 0),
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

  private controllerResultFromTerminal(terminal: TurnTerminalEvent): StateMachineExecutionResult {
    switch (terminal.type) {
      case "ask":
        return { type: "ask", questions: terminal.questions };
      case "sleep":
        return { type: "sleep", wakeAt: terminal.wakeAt };
      case "interrupted":
        return { type: "interrupted" };
      case "complete":
        return {
          type: "terminal",
          status: terminal.status,
          result: terminal.result,
          error: terminal.error,
        };
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
    return this.controllerResultToTerminal(next, state);
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
      this.setState(workerResult.terminal.state);
      const result = await this.controllerResultFromWorkerResult(
        workerResult,
        workerResult.terminal.state,
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
        prompt: input.prompt,
        appendSystemPrompt: input.state.systemPrompt,
        skills: this.skillContext.resolveStateAgentSkills(input.state),
        ...this.createTools("agent"),
      },
      (result) => {
        control = result;
      },
    );
    let unsubscribe: (() => void) | undefined;
    const finish = (): StateAgentResult => {
      const usage = usageFromMessages(agent.state.messages);
      this.recordUsage(usage);
      if (control.type === "ask_user_question") {
        return { type: "ask", questions: control.questions };
      }
      if (agent.state.errorMessage) {
        return { type: "failed", error: agent.state.errorMessage };
      }
      return { type: "complete", result: assistantText(agent.state.messages) };
    };

    return {
      prompt: async () => {
        unsubscribe = agent.subscribe((event) => this.emitAgentEvent(event));
        try {
          await agent.prompt(input.prompt);
          return finish();
        } catch (error) {
          if (this.consumeInterruptedTerminal()) return { type: "interrupted" };
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
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

  private getFollowUpQueue(): string[] {
    return [...(this.state?.followUpQueue ?? [])];
  }

  private setFollowUpQueue(prompts: string[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, followUpQueue: [...prompts] });
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

  private requireParentAgent(): Agent {
    if (!this.parentAgent) {
      throw new Error("Turn runner parent agent has not been initialized.");
    }
    return this.parentAgent;
  }

  private initializeParentAgent(): void {
    const state = this.requireRunnerState();
    const appendSystemPrompt =
      typeof state.mode === "object"
        ? createStateMachineSystemPromptLayer({ mode: state.mode, session: state })
        : undefined;
    this.parentControlResult = { type: "none" };
    this.parentAgent = this.createAgent(
      {
        state,
        prompt: "",
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
    mode: Exclude<TurnMode, "agent">;
  }): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state: input.state,
      prompt: input.prompt,
      ...this.createTools(input.mode),
    });

    const result = await this.controllerResultFromWorkerResult(workerResult, input.state);
    if (!result) return workerResult.terminal;
    return this.driveStateMachineResult(result, workerResult.terminal.state);
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
        prompt:
          workerResult.terminal.type === "complete" ? (workerResult.terminal.result ?? "") : "",
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
        prompt:
          workerResult.terminal.type === "complete" ? (workerResult.terminal.result ?? "") : "",
        definition: state.mode as Exclude<TurnMode, "agent" | "auto">,
        currentState: workerResult.control.decision.state,
      });
    }
    if (workerResult.control.decision.kind !== "fail") {
      this.emit({ type: "state_machine", currentState: workerResult.control.decision.state });
    }
    return this.stateMachineController.runDecision(workerResult.control.decision);
  }

  protected createTools(mode: TurnMode): {
    tools: AgentTool[];
  } {
    const cwd = this.config.cwd ?? process.cwd();
    const todoStorage = {
      getTodos: () => this.getTodos(),
      setTodos: (todos: TurnTodo[]) => {
        this.setTodos(todos);
        this.emit({ type: "todos", todos });
      },
    };
    const skills = this.skillContext.getSkills();
    if (mode === "agent") {
      return { tools: createDefaultTurnRunnerTools(cwd, todoStorage, skills) };
    }

    return {
      tools: createTurnRunnerTools({
        cwd,
        mode,
        getDefinition: () => this.stateMachineController.getSession()?.definition,
        getStateMachine: () => this.stateMachineController.getSession(),
        todoStorage,
        skills,
      }),
    };
  }

  private replayFollowUpQueueIntoAgent(agent: Agent): void {
    for (const prompt of this.getFollowUpQueue()) {
      agent.followUp({
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      });
    }
  }

  protected async runAgentMode(state: TurnState, prompt: string): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state,
      prompt,
      ...this.createTools("agent"),
    });
    if (workerResult.control.type === "ask_user_question") {
      return this.askUserQuestion(workerResult.terminal, workerResult.control);
    }
    return workerResult.terminal;
  }

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (this.parentAgentRunning) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }

    const agent = this.requireParentAgent();
    this.parentControlResult = { type: "none" };
    const previousMessageCount = agent.state.messages.length;
    this.setParentAgentRunning(true);

    const unsubscribe = agent.subscribe((event) => this.emitAgentEvent(event));
    let interruptedDuringPrompt: TurnTerminalEvent | undefined;
    try {
      await agent.prompt(input.prompt);
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
      return { control: this.parentControlResult, terminal: interrupted };
    }

    const messages = agent.state.messages;
    const usage = usageFromMessages(messages.slice(previousMessageCount));
    const status = agent.state.errorMessage ? "failed" : "completed";
    const state = {
      ...input.state,
      status,
      agent: {
        ...input.state.agent,
        status,
        messages,
      },
    } satisfies TurnState;

    return {
      control: this.parentControlResult,
      terminal: {
        type: "complete",
        status,
        state,
        result: assistantText(messages),
        error: agent.state.errorMessage,
        usage,
      },
    };
  }

  private setParentAgentRunning(running: boolean): void {
    this.parentAgentRunning = running;
    this.snapshotActiveAgentState();
  }

  private async runAgentWorkerWithUsage(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const result = await this.runAgentWorker(input);
    this.recordUsage(result.terminal.usage);
    return result;
  }

  protected createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const options = this.resolveTurnOptions(undefined, input.state.options);
    const model = this.resolveTurnModel(options);
    const memoryModel = this.resolveMemoryModel(options);
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
      transformContext: this.createMemoryTransform(memoryModel),
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

  protected createMemoryTransform(model: Model<any>) {
    return createObservationalMemoryTransform({
      memory: this.memory,
      actorModel: model,
      settings: this.config.memory,
      onUsage: (usage) => this.recordUsage(usage),
      onActivity: (event) => this.emit({ type: "memory", ...event }),
    });
  }

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

  private async ensureMemoryLoaded(): Promise<void> {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;

    this.memoryDispose = await loadStoredMemory(
      this.config.memoryDbPath,
      this.config.cwd ?? process.cwd(),
      this.memory,
    );
  }

  protected createBaseSystemPromptWithAppendedLayers(input?: {
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return this.skillContext.createSystemPromptWithAppendedLayers(input);
  }

  private askUserQuestion(
    terminal: TurnTerminalEvent,
    control: Extract<TurnRunnerControlResult, { type: "ask_user_question" }>,
  ): TurnTerminalEvent {
    return {
      type: "ask",
      questions: control.questions,
      state: { ...terminal.state, status: "waiting_for_human" },
    };
  }

  protected resolveMemoryModel(options?: TurnOptions): Model<any> {
    return this.resolveModelName(
      options?.memoryModel ?? this.config.memoryModel ?? DEFAULT_CLI_MEMORY_MODEL,
    );
  }

  protected resolveTurnModel(options?: TurnOptions): Model<any> {
    return this.resolveModelName(options?.model ?? this.config.model ?? DEFAULT_CLI_MODEL);
  }

  private resolveTurnOptions(options?: TurnOptions, base?: TurnOptions): TurnOptions {
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

  private resolveModelName(modelName: string): Model<any> {
    const separator = modelName.indexOf(":");
    if (separator === -1) {
      throw new Error("Models must use provider:modelId syntax");
    }
    if (isDuetGatewayModelName(modelName)) {
      const modelId = modelName.slice(separator + 1);
      const resolved = resolveDuetGatewayModel(modelId);
      if (!resolved) {
        throw new Error(`Unknown duet-gateway model: ${modelId}`);
      }
      return resolved;
    }
    const provider = modelName.slice(0, separator) as Parameters<typeof getModel>[0];
    const model = modelName.slice(separator + 1) as Parameters<typeof getModel>[1];
    return getModel(provider, model);
  }

  protected emitAgentEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "user") {
      this.removeFollowUpPrompt(agentMessageText(event.message));
    }
    for (const turnEvent of agentEventToTurnEvents(event)) {
      this.emit(turnEvent);
    }
  }
}
