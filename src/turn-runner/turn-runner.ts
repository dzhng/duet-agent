import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model, type Usage } from "@mariozechner/pi-ai";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import { createObservationalMemoryTransform } from "../memory/observational.js";
import { loadStoredMemory } from "../memory/storage.js";
import { MemoryStore } from "../memory/store.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnAnswerCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
  TurnState,
  TurnTokenUsage,
  TurnStartCommand,
  TurnRunnerTerminalStatus,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnTodo,
  TurnWakeCommand,
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
import { resolveSkillScope } from "./skills.js";
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
  /** User-visible mirror of follow-up prompts accepted by this runner. */
  private followUpQueuePrompts: string[] = [];
  /** Current todo list emitted through todo protocol events. */
  private todos: TurnTodo[] = [];
  /** Aggregates model usage across parent agents, child agents, and memory work for one turn chain. */
  private turnUsage?: TurnTokenUsage;
  /** Prevents queued user prompts from recursively preempting continuation prompts. */
  private drainingQueuedCommandsBeforeContinuation = false;
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
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

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    if (this.activeTurnPromise) {
      if (command.type === "start") {
        throw new Error("Cannot start a new turn while another turn is active.");
      }
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
      this.emit(this.buildReadyEvent());
      let terminal: TurnTerminalEvent;
      terminal = await this.executeTurnCommand(command);
      terminal = await this.drainQueuedTurnCommands(terminal);
      terminal = this.withTurnUsage(terminal);
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
      case "start":
        return this.start(command);
      case "prompt":
        return this.prompt(command);
      case "answer":
        return this.answer(command);
      case "wake":
        return this.wake(command);
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
      const command = this.rebaseQueuedCommand(queued, latest.state);
      latest = await this.executeTurnCommand(command);
    }
    return latest;
  }

  private rebaseQueuedCommand(command: TurnCommand, state: TurnState): TurnCommand {
    switch (command.type) {
      case "start":
        return {
          type: "prompt",
          state,
          message: command.prompt,
          behavior: "follow_up",
          options: command.options,
        };
      case "prompt":
        return { ...command, state };
      case "answer":
        return { ...command, state };
      case "wake":
        return { ...command, state };
    }
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
    this.followUpQueuePrompts = [...prompts];
    this.activeAgent?.clearFollowUpQueue();
    for (const prompt of this.followUpQueuePrompts) {
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
    const replacementState = this.removeQueuedFollowUpCommands();
    if (!replacementState || this.activeAgent) return;
    for (const prompt of prompts) {
      this.queuedTurnCommands.push({
        type: "prompt",
        state: replacementState,
        message: prompt,
        behavior: "follow_up",
      });
    }
  }

  private removeQueuedFollowUpCommands(): TurnState | undefined {
    let replacementState: TurnState | undefined;
    for (let index = this.queuedTurnCommands.length - 1; index >= 0; index--) {
      const command = this.queuedTurnCommands[index]!;
      if (!this.isFollowUpQueueCommand(command)) continue;
      replacementState = replacementState ?? command.state;
      this.queuedTurnCommands.splice(index, 1);
    }
    return replacementState;
  }

  private isFollowUpQueueCommand(
    command: TurnCommand,
  ): command is TurnPromptCommand | TurnAnswerCommand {
    return (
      (command.type === "prompt" || command.type === "answer") && command.behavior === "follow_up"
    );
  }

  private appendFollowUpPrompt(prompt: string): void {
    this.followUpQueuePrompts.push(prompt);
    this.emitFollowUpQueue();
  }

  private removeQueuedFollowUpPrompt(command: TurnCommand): void {
    if (!this.isFollowUpQueueCommand(command)) return;
    this.removeFollowUpPrompt(this.commandToUserMessage(command));
  }

  private removeFollowUpPrompt(prompt: string): void {
    const index = this.followUpQueuePrompts.indexOf(prompt);
    if (index === -1) return;
    this.followUpQueuePrompts.splice(index, 1);
    this.emitFollowUpQueue();
  }

  private clearFollowUpQueue(): void {
    if (this.followUpQueuePrompts.length === 0) return;
    this.followUpQueuePrompts = [];
    this.emitFollowUpQueue();
  }

  private emitFollowUpQueue(): void {
    this.emit({ type: "follow_up_queue", prompts: [...this.followUpQueuePrompts] });
  }

  interrupt(command: TurnInterruptCommand): void {
    const interruptedState = this.stateMachineRuntime.recordStateInterrupted(
      command.state,
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

  private buildReadyEvent(): TurnEvent {
    const cwd = this.config.cwd ?? process.cwd();
    return {
      type: "ready",
      skills: this.skillContext.getSkills().map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.baseDir,
        scope: resolveSkillScope(skill, cwd),
      })),
      agentFiles: this.skillContext.getResolvedAgentFiles(),
    };
  }

  private consumeInterruptedTerminal(): TurnTerminalEvent | undefined {
    const terminal = this.interruptedTerminal;
    this.interruptedTerminal = undefined;
    return terminal;
  }

  protected async start(command: TurnStartCommand): Promise<TurnTerminalEvent> {
    const mode = command.mode ?? this.config.mode ?? "auto";
    const state = this.stateMachineRuntime.createInitialState(mode);
    const prompt = this.skillContext.resolveSlashSkillPrompt(command.prompt);
    this.emit({ type: "session_started", state });

    if (mode === "agent") {
      return this.runAgentMode(state, prompt, command.options);
    }

    return this.runTurnRunnerAgentWithStateMachineTools({
      state,
      prompt,
      mode,
      options: command.options,
    });
  }

  protected async prompt(command: TurnPromptCommand): Promise<TurnTerminalEvent> {
    const state: TurnState = { ...command.state, status: "running" };
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

    return this.stateMachineRuntime.restoreSleepAfterPromptIfNeeded(command.state, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;

    const stateMachine = command.state.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.stateMachineRuntime.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.state.status === "waiting_for_human" && currentState?.kind === "agent") {
      const session = this.stateMachineRuntime.appendUserMessage(
        { ...command.state, status: "running" },
        message,
      );
      return this.stateMachineRuntime.runAgentState(session, currentState);
    }

    return this.prompt({
      type: "prompt",
      state: command.state,
      message,
      behavior: command.behavior,
      options: command.options,
    });
  }

  protected async wake(command: TurnWakeCommand): Promise<TurnTerminalEvent> {
    const state: TurnState = { ...command.state, status: "running" };
    const stateMachine = state.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.stateMachineRuntime.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.state.status === "sleeping" && currentState?.kind === "poll") {
      return this.stateMachineRuntime.runPollState(state, currentState, { woke: true });
    }

    return {
      type: "complete",
      status: "completed",
      state: command.state,
      result: "Nothing to wake.",
    };
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
      getTodos: () => this.todos,
      setTodos: (todos: TurnTodo[]) => {
        this.todos = todos;
      },
    };
    if (mode === "agent") {
      return { tools: createDefaultTurnRunnerTools(cwd, todoStorage) };
    }

    return {
      tools: createTurnRunnerTools({
        cwd,
        mode,
        definition: session?.stateMachine?.definition,
        todoStorage,
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
    return new Agent({
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
    const provider = modelName.slice(0, separator) as Parameters<typeof getModel>[0];
    const model = modelName.slice(separator + 1) as Parameters<typeof getModel>[1];
    return getModel(provider, model);
  }

  protected emitAgentEvent(event: AgentEvent): void {
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
