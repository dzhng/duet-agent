import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model, type Usage } from "@mariozechner/pi-ai";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";

import { isDuetGatewayModelName, resolveDuetGatewayModel } from "../duet-gateway/index.js";
import { toXML } from "../lib/xml.js";
import { createObservationalMemoryTransform } from "../memory/observational.js";
import { loadStoredMemory } from "../memory/storage.js";
import { MemoryStore } from "../memory/store.js";
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
  TurnRunnerTerminalStatus,
  TurnStartCommand,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnTodo,
} from "../types/protocol.js";
import { createStateMachineSystemPromptLayer } from "./prompts.js";
import {
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  type TurnRunnerControlResult,
} from "./tools.js";
import {
  emitAgentEvent as emitAgentWorkerEvent,
  isTodoWriteToolDetails,
  isTurnRunnerControlResult,
  runAgentWorker,
  type ActiveAgentSlot,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "./agent-worker.js";
import { SkillContext } from "./skill-context.js";
import { StateMachineRuntime, type ActiveStateWork } from "./state-machine-runtime.js";
import { addUsage } from "./usage-accounting.js";

const DEFAULT_MODEL = "anthropic:claude-opus-4-7";
const DEFAULT_MEMORY_MODEL = "anthropic:claude-sonnet-4-6";

export type TurnEventHandler = (event: TurnEvent) => void;

export type { AgentWorkerInput, AgentWorkerResult } from "./agent-worker.js";

export class TurnRunner {
  private readonly eventHandlers = new Set<TurnEventHandler>();
  /** In-memory observation store used by context transforms during agent turns. */
  protected readonly memory = new MemoryStore();
  /** Stops memory persistence subscriptions/databases when the runner is disposed. */
  private memoryDispose?: () => Promise<void>;
  /**
   * Active parent pi agent. Prompts, steers, and follow-ups only target this
   * transcript so all user-visible conversation stays linear in the parent.
   */
  private activeAgent?: Agent;
  /**
   * Active state-machine child pi agent, when a child state is running. Child
   * agents run without state-machine tools; only command types explicitly routed
   * to children should use this slot, while normal prompts queue for the parent.
   */
  private activeChildAgent?: Agent;
  /** Current script or poll abort controller, used to interrupt non-agent state work. */
  private activeAbortController?: AbortController;
  /** Current non-agent state work, if a script or poll owns the active turn. */
  private activeStateWork?: ActiveStateWork;
  /** Terminal event prepared by `interrupt()` and returned when active work unwinds. */
  private interruptedTerminal?: TurnTerminalEvent;
  /**
   * Active work-chain promise. Callers may call turn() repeatedly while this is
   * set; those commands either join the active pi agent as steer/follow-up or
   * queue behind non-agent work. The runner emits one terminal for the chain.
   */
  private activeTurnPromise?: Promise<TurnTerminalEvent>;
  /** Commands that could not be absorbed into the active pi agent and must run later. */
  private readonly queuedTurnCommands: TurnCommand[] = [];
  /**
   * Latest runner-owned state. Hydrated by start(), advanced through terminal
   * events, and continuously updated mid-turn so `getState()` returns a fresh
   * snapshot at any instant: agent messages sync on each agent event, the
   * TodoWrite tool mutates `state.todos`, and follow-up queue ops mutate
   * `state.followUpQueue`.
   */
  private state?: TurnState;
  /** Aggregates model usage across parent agents, child agents, and memory work for one turn chain. */
  private turnUsage?: TurnTokenUsage;
  /** Prevents queued user prompts from recursively preempting continuation prompts. */
  private drainingQueuedCommandsBeforeContinuation = false;
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
  /**
   * Set by `start()` when resumed state carries a non-empty follow-up queue.
   * The first parent pi agent created after start consumes the flag and
   * replays the queue into pi's follow-up channel.
   */
  private pendingFollowUpReplay = false;
  private readonly skillContext: SkillContext;
  private readonly stateMachineRuntime: StateMachineRuntime;

  constructor(readonly config: TurnRunnerConfig) {
    this.skillContext = new SkillContext(config);
    this.stateMachineRuntime = new StateMachineRuntime({
      cwd: () => this.config.cwd ?? process.cwd(),
      emit: (event) => this.emit(event),
      complete: (session, status, result, error) => this.complete(session, status, result, error),
      askUserQuestion: (terminal, control) => this.askUserQuestion(terminal, control),
      createTools: (mode, session) => this.createTools(mode, session),
      runAgentWorkerWithUsage: (input, activeSlot) =>
        this.runAgentWorkerWithUsage(input, activeSlot),
      resolveStateAgentSkills: (state) => this.skillContext.resolveStateAgentSkills(state),
      prompt: (command) => this.prompt(command),
      drainQueuedTurnCommands: (terminal) => this.drainQueuedTurnCommands(terminal),
      hasQueuedTurnCommands: () => this.queuedTurnCommands.length > 0,
      isDrainingQueuedCommandsBeforeContinuation: () =>
        this.drainingQueuedCommandsBeforeContinuation,
      setDrainingQueuedCommandsBeforeContinuation: (value) => {
        this.drainingQueuedCommandsBeforeContinuation = value;
      },
      setCurrentState: (state) => {
        this.state = state;
      },
      consumeInterruptedTerminal: () => this.consumeInterruptedTerminal(),
      setActiveAbortController: (controller) => {
        this.activeAbortController = controller;
      },
      setActiveStateWork: (work) => {
        this.activeStateWork = work;
      },
    });
  }

  async dispose(): Promise<void> {
    this.activeAgent?.clearAllQueues();
    this.activeChildAgent?.clearAllQueues();
    this.queuedTurnCommands.length = 0;
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
    const state = this.normalizeResumedState(
      command.state ?? this.stateMachineRuntime.createInitialState(mode),
    );
    this.state = state;
    this.pendingFollowUpReplay = state.followUpQueue.length > 0;
    if (this.pendingFollowUpReplay) {
      this.emit({ type: "follow_up_queue", prompts: [...state.followUpQueue] });
    }
    this.emit({ type: "turn_started", state });
    return state;
  }

  /**
   * Backfill `todos` and `followUpQueue` for resumed states written before
   * those fields were on `TurnState`. Without this, hydrated state from disk
   * would be missing required fields.
   */
  private normalizeResumedState(state: TurnState): TurnState {
    return {
      ...state,
      todos: state.todos ?? [],
      followUpQueue: state.followUpQueue ?? [],
    };
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
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
      terminal = this.withTurnUsage(terminal);
      this.state = terminal.state;
      this.emit(terminal);
      return terminal;
    } finally {
      this.turnUsage = undefined;
    }
  }

  private withTurnUsage<T extends TurnTerminalEvent>(terminal: T): T {
    if (!this.turnUsage) return terminal;
    return { ...terminal, usage: this.turnUsage };
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
    if ((command.type === "prompt" || command.type === "answer") && this.activeAgent) {
      // State-machine continuations and normal user input stay linear by
      // entering the active parent transcript as pi follow-ups.
      this.sendCommandToAgent(this.activeAgent, command);
      return;
    }

    if (command.type === "answer" && this.activeChildAgent) {
      this.sendCommandToAgent(this.activeChildAgent, command);
      return;
    }

    if (
      (command.type === "prompt" || command.type === "answer") &&
      this.activeStateWork?.kind === "poll"
    ) {
      this.runPromptDuringActivePoll(this.activeStateWork, command);
      return;
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

  private async drainQueuedTurnCommands(terminal: TurnTerminalEvent): Promise<TurnTerminalEvent> {
    let latest = terminal;
    while (this.queuedTurnCommands.length > 0) {
      if (
        latest.type === "interrupted" ||
        (latest.type === "complete" && latest.status === "failed")
      ) {
        this.queuedTurnCommands.length = 0;
        this.clearFollowUpQueue();
        return latest;
      }
      const queued = this.queuedTurnCommands.shift()!;
      this.removeQueuedFollowUpPrompt(queued);
      this.state = latest.state;
      latest = await this.executeTurnCommand(queued);
    }
    return latest;
  }

  private runPromptDuringActivePoll(
    work: Extract<ActiveStateWork, { kind: "poll" }>,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): void {
    if (work.promptTerminal) {
      this.enqueueTurnCommand(command);
      return;
    }

    const prompt = this.commandToUserMessage(command);
    this.stateMachineRuntime.runPromptDuringActivePoll(work, command, prompt);
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
    this.queuedTurnCommands.push(command);
  }

  private replaceFollowUpQueue(prompts: string[]): void {
    this.setFollowUpQueue([...prompts]);
    this.activeAgent?.clearFollowUpQueue();
    for (const prompt of prompts) {
      this.activeAgent?.followUp({
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
    if (!this.state || this.activeAgent) return;
    for (const prompt of prompts) {
      this.queuedTurnCommands.push({
        type: "prompt",
        message: prompt,
        behavior: "follow_up",
      });
    }
  }

  private removeQueuedFollowUpCommands(): void {
    for (let index = this.queuedTurnCommands.length - 1; index >= 0; index--) {
      const command = this.queuedTurnCommands[index]!;
      if (!this.isFollowUpQueueCommand(command)) continue;
      this.queuedTurnCommands.splice(index, 1);
    }
  }

  private isFollowUpQueueCommand(
    command: TurnCommand,
  ): command is TurnPromptCommand | TurnAnswerCommand {
    return (
      (command.type === "prompt" || command.type === "answer") && command.behavior === "follow_up"
    );
  }

  private getFollowUpQueue(): string[] {
    return this.state?.followUpQueue ?? [];
  }

  private setFollowUpQueue(prompts: string[]): void {
    if (!this.state) return;
    this.state = { ...this.state, followUpQueue: prompts };
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
    const queue = this.getFollowUpQueue();
    const index = queue.indexOf(prompt);
    if (index === -1) return;
    const next = queue.slice();
    next.splice(index, 1);
    this.setFollowUpQueue(next);
    this.emitFollowUpQueue();
  }

  private clearFollowUpQueue(): void {
    if (this.getFollowUpQueue().length === 0) return;
    this.setFollowUpQueue([]);
    this.emitFollowUpQueue();
  }

  private emitFollowUpQueue(): void {
    this.emit({ type: "follow_up_queue", prompts: [...this.getFollowUpQueue()] });
  }

  interrupt(_command: TurnInterruptCommand): void {
    if (!this.state) return;
    const interruptedState = this.stateMachineRuntime.recordStateInterrupted(
      this.state,
      "Interrupted",
    );
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {
        ...interruptedState,
        status: "interrupted",
        agent: { ...interruptedState.agent, status: "cancelled" },
      },
    };
    this.state = terminal.state;
    if (this.activeAgent || this.activeChildAgent || this.activeAbortController) {
      // The active turn emits this terminal event after agent.prompt() unwinds.
      // interrupt() only aborts out-of-band; it does not own turn completion.
      this.interruptedTerminal = terminal;
    }
    this.activeAgent?.abort();
    this.activeChildAgent?.abort();
    this.activeAbortController?.abort();
    this.activeAgent?.clearAllQueues();
    this.activeChildAgent?.clearAllQueues();
    this.queuedTurnCommands.length = 0;
    this.clearFollowUpQueue();
    this.activeAgent = undefined;
    this.activeChildAgent = undefined;
    this.activeAbortController = undefined;
    this.activeStateWork = undefined;
  }

  protected emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  /**
   * Latest turn-runner state. Returns a fresh snapshot at any moment,
   * including mid-turn: agent messages and status are synced as the live
   * agent emits events; todos and follow-up queue mutations write through
   * `this.state` directly. Use this for shutdown flushes when you need to
   * persist whatever state is current right now.
   */
  getState(): TurnState | undefined {
    if (!this.state) return undefined;
    return {
      ...this.state,
      agent: { ...this.state.agent, messages: [...this.state.agent.messages] },
      todos: [...this.state.todos],
      followUpQueue: [...this.state.followUpQueue],
    };
  }

  /**
   * Sync the runner's `state.agent` with the live agent's messages and status.
   * Called on each agent event so `getState()` returns a fresh transcript at
   * any moment (e.g., mid-turn shutdown flushes).
   */
  protected syncAgentState(messages: AgentMessage[], errorMessage: string | undefined): void {
    if (!this.state) return;
    const status = errorMessage ? "failed" : "running";
    this.state = {
      ...this.state,
      agent: {
        ...this.state.agent,
        status,
        messages,
      },
    };
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
      terminal = await this.runAgentMode(state, prompt, command.options);
    } else {
      terminal = await this.runTurnRunnerAgentWithStateMachineTools({
        state,
        prompt,
        mode: state.mode,
        options: command.options,
      });
    }

    return this.stateMachineRuntime.restoreSleepAfterPromptIfNeeded(originalState, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;

    const currentRunnerState = this.requireRunnerState();
    const stateMachine = currentRunnerState.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.stateMachineRuntime.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (currentRunnerState.status === "waiting_for_human" && currentState?.kind === "agent") {
      const session = this.stateMachineRuntime.appendUserMessage(
        { ...currentRunnerState, status: "running" },
        message,
      );
      return this.stateMachineRuntime.runAgentState(session, currentState);
    }

    return this.prompt({
      type: "prompt",
      message,
      behavior: command.behavior,
      options: command.options,
    });
  }

  protected async wake(): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state: TurnState = { ...originalState, status: "running" };
    const stateMachine = state.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.stateMachineRuntime.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (originalState.status === "sleeping" && currentState?.kind === "poll") {
      return this.stateMachineRuntime.runPollState(state, currentState, { woke: true });
    }

    return {
      type: "complete",
      status: "completed",
      state: originalState,
      result: "Nothing to wake.",
    };
  }

  private requireRunnerState(): TurnState {
    if (!this.state) {
      throw new Error("Turn runner has not been started.");
    }
    return this.state;
  }

  protected async runTurnRunnerAgentWithStateMachineTools(input: {
    state: TurnState;
    prompt: string;
    mode: Exclude<TurnMode, "agent">;
    options?: TurnOptions;
  }): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state: input.state,
      prompt: input.prompt,
      options: input.options,
      appendSystemPrompt: createStateMachineSystemPromptLayer({
        mode: input.mode,
        session: input.state,
      }),
      ...this.createTools(input.mode, input.state),
    });

    if (workerResult.control.type === "none") return workerResult.terminal;

    if (workerResult.control.type === "ask_user_question") {
      return this.askUserQuestion(workerResult.terminal, workerResult.control);
    }

    if (workerResult.control.type === "create_state_machine_definition") {
      if (
        workerResult.terminal.state.stateMachine &&
        !workerResult.terminal.state.stateMachine.terminal
      ) {
        return this.complete(
          workerResult.terminal.state,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }

      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      const state = this.stateMachineRuntime.initializeState(
        workerResult.terminal.state,
        input.prompt,
        workerResult.control.definition,
        firstState,
      );
      return this.stateMachineRuntime.run(state, { kind: "run_state", state: firstState });
    }

    if (workerResult.control.type === "prompt_state_machine_agent") {
      return this.stateMachineRuntime.promptAgent(
        workerResult.terminal.state,
        workerResult.control.prompt,
      );
    }

    if (workerResult.control.type !== "select_state_machine_state") {
      return this.complete(
        workerResult.terminal.state,
        "failed",
        undefined,
        "Unsupported state-machine control result.",
      );
    }

    const selectedState =
      !workerResult.terminal.state.stateMachine &&
      typeof input.mode === "object" &&
      workerResult.control.decision.kind !== "fail"
        ? this.stateMachineRuntime.initializeState(
            workerResult.terminal.state,
            input.prompt,
            input.mode,
            workerResult.control.decision.state,
          )
        : workerResult.terminal.state;
    return this.stateMachineRuntime.run(selectedState, workerResult.control.decision);
  }

  protected createTools(
    mode: TurnMode,
    session?: TurnState,
  ): {
    tools: AgentTool[];
  } {
    const cwd = this.config.cwd ?? process.cwd();
    const todoStorage = {
      getTodos: (): TurnTodo[] => this.state?.todos ?? [],
      setTodos: (todos: TurnTodo[]) => {
        if (this.state) {
          this.state = { ...this.state, todos };
        }
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
        definition: session?.stateMachine?.definition,
        todoStorage,
        skills,
      }),
    };
  }

  protected async runAgentMode(
    state: TurnState,
    prompt: string,
    options?: TurnOptions,
  ): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorkerWithUsage({
      state,
      prompt,
      options,
      ...this.createTools("agent"),
    });
    if (workerResult.control.type === "ask_user_question") {
      return this.askUserQuestion(workerResult.terminal, workerResult.control);
    }
    return workerResult.terminal;
  }

  protected async runAgentWorker(
    input: AgentWorkerInput,
    activeSlot: ActiveAgentSlot = "parent",
  ): Promise<AgentWorkerResult> {
    return runAgentWorker(
      {
        getActiveAgent: (slot) => (slot === "parent" ? this.activeAgent : this.activeChildAgent),
        setActiveAgent: (slot, agent) => {
          if (slot === "parent") {
            this.activeAgent = agent;
            if (agent) this.replayPendingFollowUpsInto(agent);
          } else {
            this.activeChildAgent = agent;
          }
        },
        createAgent: (workerInput, onControlResult) =>
          this.createAgent(workerInput, onControlResult),
        emitAgentEvent: (event) => this.emitAgentEvent(event),
        consumeInterruptedTerminal: () => this.consumeInterruptedTerminal(),
      },
      input,
      activeSlot,
    );
  }

  private async runAgentWorkerWithUsage(
    input: AgentWorkerInput,
    activeSlot: ActiveAgentSlot = "parent",
  ): Promise<AgentWorkerResult> {
    const result = await this.runAgentWorker(input, activeSlot);
    this.recordUsage(result.terminal.usage);
    return result;
  }

  protected createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const model = this.resolveTurnModel(input.options);
    const memoryModel = this.resolveMemoryModel(input.options);
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel: input.options?.thinkingLevel ?? this.config.thinkingLevel ?? "medium",
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
        if (isTurnRunnerControlResult(context.result.details)) {
          onControlResult?.(context.result.details);
        }
        if (isTodoWriteToolDetails(context.result.details)) {
          this.emit({ type: "todos", todos: context.result.details.todos });
        }
        return undefined;
      },
      getApiKey: getEnvApiKey,
    });
    return agent;
  }

  /**
   * On resume, push each persisted follow-up prompt into the freshly created
   * parent pi agent so it drains them after the current user prompt. Only
   * runs once per session (consumes a flag set by `start()`), and only for
   * the parent slot — child state-machine agents share the parent's transcript
   * but should not absorb user-level follow-ups.
   */
  private replayPendingFollowUpsInto(agent: Agent): void {
    if (!this.pendingFollowUpReplay) return;
    this.pendingFollowUpReplay = false;
    const queue = this.getFollowUpQueue();
    for (const prompt of queue) {
      agent.followUp({
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      });
    }
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

  protected resolveTurnModel(options?: TurnOptions): Model<any> {
    return this.resolveModelName(options?.model ?? this.config.model ?? DEFAULT_MODEL);
  }

  protected resolveMemoryModel(options?: TurnOptions): Model<any> {
    return this.resolveModelName(
      options?.memoryModel ?? this.config.memoryModel ?? DEFAULT_MEMORY_MODEL,
    );
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
    // Sync the live agent's transcript into runner state so `getState()`
    // returns a fresh snapshot mid-turn (e.g., for shutdown flushes). The
    // child slot is preferred when active because its events are what's
    // currently driving the conversation; child transcripts share the parent
    // message list (child starts with parent.messages and appends).
    const liveAgent = this.activeChildAgent ?? this.activeAgent;
    if (liveAgent) {
      this.syncAgentState(liveAgent.state.messages, liveAgent.state.errorMessage);
    }
    emitAgentWorkerEvent(
      event,
      (turnEvent) => this.emit(turnEvent),
      (prompt) => this.removeFollowUpPrompt(prompt),
    );
  }

  private complete(
    session: TurnState,
    status: TurnRunnerTerminalStatus,
    result?: string,
    error?: string,
  ): TurnTerminalEvent {
    return {
      type: "complete",
      status,
      result,
      error,
      state: {
        ...session,
        status,
      },
    };
  }
}
