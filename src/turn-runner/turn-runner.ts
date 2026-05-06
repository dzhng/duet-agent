import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model, type Usage } from "@mariozechner/pi-ai";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { execFile, type ExecException } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { assistantText } from "../core/serializer.js";
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
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineSession,
  StateMachineScriptState,
  StateMachineState,
  StateMachineTerminalState,
} from "../types/state-machine.js";
import {
  createSystemPromptWithAppendedLayers,
  createStateMachineSystemPromptLayer,
} from "./prompts.js";
import {
  loadDiscoveredSkills,
  mergeSkillsByName,
  prepareExplicitSkills,
  readSkillInstructions,
} from "./skills.js";
import {
  applyStateOverride,
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  type TodoWriteToolDetails,
  type TurnRunnerControlResult,
  type StateMachineRunnerDecision,
} from "./tools.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "anthropic:claude-opus-4-7";
const DEFAULT_MEMORY_MODEL = "anthropic:claude-sonnet-4-6";

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  options?: TurnOptions;
  appendSystemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
}

export interface AgentWorkerResult {
  terminal: TurnTerminalEvent;
  control: TurnRunnerControlResult;
}

type ShellCommandOutput = { stdout: string; stderr: string; exitCode: number };

type ActiveStateWork =
  | { kind: "script" }
  | {
      kind: "poll";
      session: TurnState;
      state: StateMachinePollState;
      promptStarted: Promise<void>;
      resolvePromptStarted: () => void;
      promptTerminal?: Promise<TurnTerminalEvent>;
    };

function parseSlashCommands(prompt: string): {
  commands: string[];
} {
  const tokens = prompt.trim().split(/\s+/);
  const commands: string[] = [];

  for (const token of tokens) {
    const match = token.match(/^\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      commands.push(match[1]!);
    }
  }

  return { commands };
}

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
  /** Explicit and discovered skills available for prompt injection and slash commands. */
  private skills: Skill[] = [];
  /** Ensures skill discovery runs once even when multiple turns share this runner. */
  private skillsLoaded = false;
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;

  constructor(readonly config: TurnRunnerConfig) {
    if (config.skills) {
      this.skills = prepareExplicitSkills(config.skills);
    }
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
      this.emit({ type: "ready" });
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
    work.promptTerminal = this.prompt({
      type: "prompt",
      state: { ...work.session, status: "running" },
      message: prompt,
      behavior: command.behavior,
      options: command.options,
    }).then((terminal) => this.restorePollSleepAfterMidPollPrompt(work, terminal));
    work.resolvePromptStarted();
  }

  private restorePollSleepAfterMidPollPrompt(
    work: Extract<ActiveStateWork, { kind: "poll" }>,
    terminal: TurnTerminalEvent,
  ): TurnTerminalEvent {
    if (terminal.type !== "complete" || terminal.status !== "completed") {
      return terminal;
    }

    const currentPoll = this.currentPollState(terminal.state);
    if (!currentPoll || currentPoll.name !== work.state.name) {
      return terminal;
    }

    return this.sleep(terminal.state, currentPoll);
  }

  private commandToUserMessage(command: TurnPromptCommand | TurnAnswerCommand): string {
    if (command.type === "prompt") {
      return this.resolveSlashSkillPrompt(command.message);
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
    const interruptedState = this.recordStateInterrupted(command.state, "Interrupted");
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

  protected async start(command: TurnStartCommand): Promise<TurnTerminalEvent> {
    const mode = command.mode ?? this.config.mode ?? "auto";
    const state = this.createInitialState(mode);
    const prompt = this.resolveSlashSkillPrompt(command.prompt);
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
    const prompt = this.resolveSlashSkillPrompt(command.message);
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

    return this.restoreSleepAfterPromptIfNeeded(command.state, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;

    const stateMachine = command.state.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.state.status === "waiting_for_human" && currentState?.kind === "agent") {
      const session = this.appendUserMessage({ ...command.state, status: "running" }, message);
      return this.runStateMachineAgentState(session, currentState);
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
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.state.status === "sleeping" && currentState?.kind === "poll") {
      return this.runStateMachinePollState(state, currentState, { woke: true });
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
      const state = this.initializeStateMachineState(
        workerResult.terminal.state,
        input.prompt,
        workerResult.control.definition,
        firstState,
      );
      return this.runStateMachine(state, { kind: "run_state", state: firstState });
    }

    if (workerResult.control.type === "prompt_state_machine_agent") {
      return this.promptStateMachineAgent(workerResult.terminal.state, workerResult.control.prompt);
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
        ? this.initializeStateMachineState(
            workerResult.terminal.state,
            input.prompt,
            input.mode,
            workerResult.control.decision.state,
          )
        : workerResult.terminal.state;
    return this.runStateMachine(selectedState, workerResult.control.decision);
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
    activeSlot: "parent" | "state_machine_child" = "parent",
  ): Promise<AgentWorkerResult> {
    if (activeSlot === "parent" && this.activeAgent) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }
    if (activeSlot === "state_machine_child" && this.activeChildAgent) {
      throw new Error(
        "Cannot start a state-machine child agent while another child agent is active.",
      );
    }

    let control: TurnRunnerControlResult = { type: "none" };
    const agent = this.createAgent(input, (result) => {
      control = result;
    });
    if (activeSlot === "parent") {
      this.activeAgent = agent;
    } else {
      this.activeChildAgent = agent;
    }

    const unsubscribe = agent.subscribe((event) => this.emitAgentEvent(event));
    try {
      await agent.prompt(input.prompt);
    } catch (error) {
      if (!this.interruptedTerminal) {
        throw error;
      }
    } finally {
      unsubscribe();
      if (activeSlot === "parent") {
        this.activeAgent = undefined;
      } else {
        this.activeChildAgent = undefined;
      }
    }

    if (this.interruptedTerminal) {
      const terminal = this.interruptedTerminal;
      this.interruptedTerminal = undefined;
      return { control, terminal };
    }

    const messages = agent.state.messages;
    const usage = this.usageFromMessages(messages.slice(input.state.agent.messages.length));
    const status = agent.state.errorMessage ? "failed" : "completed";
    const state = {
      ...input.state,
      status,
      agent: {
        status,
        messages,
      },
    } satisfies TurnState;

    return {
      control,
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

  private async runAgentWorkerWithUsage(
    input: AgentWorkerInput,
    activeSlot: "parent" | "state_machine_child" = "parent",
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
        if (this.isTurnRunnerControlResult(context.result.details)) {
          onControlResult?.(context.result.details);
        }
        if (this.isTodoWriteToolDetails(context.result.details)) {
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
    return [...this.skills];
  }

  getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.name === skillId);
    return skill ? readSkillInstructions(skill) : "";
  }

  private resolveStateAgentSkills(state: StateMachineAgentState): Skill[] | undefined {
    if (!state.allowedSkills) return undefined;

    const skillsByName = new Map(this.skills.map((skill) => [skill.name, skill]));
    const missing = state.allowedSkills.filter((name) => !skillsByName.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown allowedSkills for state "${state.name}": ${missing.join(", ")}`);
    }

    return state.allowedSkills.map((name) => skillsByName.get(name)!);
  }

  private resolveSlashSkillPrompt(prompt: string): string {
    const slash = parseSlashCommands(prompt);
    if (slash.commands.length === 0) return prompt;

    const skillBlocks: string[] = [];
    for (const command of slash.commands) {
      const skill = this.skills.find((item) => item.name === command);
      if (!skill) continue;

      const instructions = readSkillInstructions(skill).trim();
      skillBlocks.push(
        [
          `<skill name="${skill.name}">`,
          "Use the following skill instructions for this request.",
          "<instructions>",
          instructions,
          "</instructions>",
          "</skill>",
        ].join("\n"),
      );
    }

    if (skillBlocks.length === 0) return prompt;

    return [prompt, ...skillBlocks].join("\n\n");
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) return;
    this.skillsLoaded = true;

    const discovered = loadDiscoveredSkills(
      this.config.skillDiscovery,
      this.config.cwd ?? process.cwd(),
    );
    this.skills = mergeSkillsByName(this.skills, discovered);
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
    return createSystemPromptWithAppendedLayers({
      config: this.config,
      skills: input?.skills ?? this.skills,
      append: [...this.readSystemPromptFileLayers(), ...(input?.append ?? [])],
    });
  }

  private readSystemPromptFileLayers(): string[] {
    const cwd = this.config.cwd ?? process.cwd();
    const fileNames = this.config.systemPromptFiles ?? ["AGENTS.md"];
    const layers: string[] = [];
    for (const fileName of fileNames) {
      const path = join(cwd, fileName);
      if (!existsSync(path)) continue;
      layers.push(
        toXML({
          system_prompt_file: {
            _attrs: { path: fileName },
            content: readFileSync(path, "utf-8").trim(),
          },
        }),
      );
    }
    return layers;
  }

  private isTurnRunnerControlResult(value: unknown): value is TurnRunnerControlResult {
    if (!value || typeof value !== "object" || !("type" in value)) return false;
    const type = value.type;
    return (
      type === "none" ||
      type === "ask_user_question" ||
      type === "create_state_machine_definition" ||
      type === "select_state_machine_state" ||
      type === "prompt_state_machine_agent"
    );
  }

  private isTodoWriteToolDetails(value: unknown): value is TodoWriteToolDetails {
    return Boolean(
      value && typeof value === "object" && "type" in value && value.type === "todo_write",
    );
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

  protected async runStateMachine(
    session: TurnState,
    decision: StateMachineRunnerDecision,
  ): Promise<TurnTerminalEvent> {
    const stateMachine = session.stateMachine;
    if (!stateMachine) {
      return this.complete(session, "failed", undefined, "No state machine is active.");
    }

    stateMachine.history.push({ type: "runner_decided", timestamp: Date.now(), decision });

    if (decision.kind === "fail") {
      return this.complete(session, "failed", undefined, decision.reason);
    }

    const selectedState = this.findState(stateMachine, decision.state);
    if (!selectedState) {
      const validStates = stateMachine.definition.states.map((state) => state.name);
      return this.complete(
        session,
        "failed",
        undefined,
        `Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`,
      );
    }

    const effectiveState =
      decision.kind === "run_state"
        ? applyStateOverride(selectedState, decision.override)
        : selectedState;
    const nextSession = this.recordStateStarted(
      session,
      effectiveState,
      decision.kind === "run_state" ? decision.input : undefined,
    );

    this.emit({ type: "state_machine", currentState: effectiveState.name });

    switch (effectiveState.kind) {
      case "agent":
        return this.runStateMachineAgentState(nextSession, effectiveState);
      case "script":
        return this.runStateMachineScriptState(nextSession, effectiveState);
      case "poll":
        return this.runStateMachinePollState(nextSession, effectiveState);
      case "terminal":
        return this.runStateMachineTerminalState(nextSession, effectiveState);
    }
  }

  protected async runStateMachineAgentState(
    session: TurnState,
    state: StateMachineAgentState,
  ): Promise<TurnTerminalEvent> {
    const childPrompt = this.renderTemplate(state.prompt, session.stateMachine?.currentInput ?? {});
    return this.runStateMachineAgentStatePrompt(session, state, childPrompt);
  }

  protected async promptStateMachineAgent(
    session: TurnState,
    prompt: string,
  ): Promise<TurnTerminalEvent> {
    const stateMachine = session.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;
    if (!stateMachine || currentState?.kind !== "agent") {
      return this.complete(
        session,
        "failed",
        undefined,
        "Cannot prompt state-machine agent because the current state is not an agent state.",
      );
    }
    return this.runStateMachineAgentStatePrompt(session, currentState, prompt);
  }

  protected async runStateMachineAgentStatePrompt(
    session: TurnState,
    state: StateMachineAgentState,
    prompt: string,
  ): Promise<TurnTerminalEvent> {
    const childState: TurnState = {
      ...session,
      mode: "agent",
      status: "running",
      stateMachine: undefined,
      agent: { ...session.agent, status: "running" },
    };
    const childWorkerResult = await this.runAgentWorkerWithUsage(
      {
        state: childState,
        prompt,
        appendSystemPrompt: state.systemPrompt,
        skills: this.resolveStateAgentSkills(state),
        ...this.createTools("agent"),
      },
      "state_machine_child",
    );
    const childResult = childWorkerResult.terminal;
    const parentSession = { ...session, agent: childResult.state.agent };
    const rawOutput = {
      result: childResult.type === "complete" ? childResult.result : undefined,
      childStatus: childResult.state.status,
      terminal: childResult,
    };
    const updatedSession = this.recordStateCompleted(parentSession, state.name, rawOutput);

    if (childResult.type === "ask") {
      return { ...childResult, state: { ...updatedSession, status: "waiting_for_human" } };
    }
    if (childResult.type === "sleep") {
      return { ...childResult, state: { ...updatedSession, status: "sleeping" } };
    }
    if (childResult.type === "interrupted") {
      return { ...childResult, state: { ...updatedSession, status: "interrupted" } };
    }

    return this.continueStateMachineAfterStateCompleted(
      { ...updatedSession, status: "running" },
      state.name,
      rawOutput,
    );
  }

  protected async runStateMachineScriptState(
    session: TurnState,
    state: StateMachineScriptState,
  ): Promise<TurnTerminalEvent> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeStateWork = { kind: "script" };
    try {
      const command = this.renderTemplate(state.command, session.stateMachine?.currentInput ?? {});
      const shellOutput = await this.runShellCommand(command, {
        cwd: state.cwd ?? this.config.cwd ?? process.cwd(),
        timeoutMs: state.timeoutMs,
        signal: abortController.signal,
        successCodes: state.successCodes,
      });
      const { stdout } = shellOutput;
      const output = this.parseStructuredOutput(stdout);
      const rawOutput = {
        ...shellOutput,
        stdout: stdout.trim(),
        stderr: shellOutput.stderr.trim(),
        parsed: output,
      };
      return this.continueStateMachineAfterStateCompleted(
        this.recordStateCompleted(session, state.name, rawOutput),
        state.name,
        rawOutput,
      );
    } catch (error) {
      if (this.interruptedTerminal) {
        const terminal = this.interruptedTerminal;
        this.interruptedTerminal = undefined;
        return terminal;
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.complete(
        this.recordStateFailed(session, state.name, message),
        "failed",
        undefined,
        message,
      );
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = undefined;
      }
      if (this.activeStateWork?.kind === "script") {
        this.activeStateWork = undefined;
      }
    }
  }

  protected async runStateMachinePollState(
    session: TurnState,
    state: StateMachinePollState,
    options?: { woke?: boolean },
  ): Promise<TurnTerminalEvent> {
    const elapsedMs = this.elapsedSinceStateStarted(session, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      return this.complete(
        this.recordStateFailed(session, state.name, message),
        "failed",
        undefined,
        message,
      );
    }

    if (state.poll.kind === "timer") {
      if (!options?.woke) {
        return this.sleep(session, state);
      }
      const output = { elapsedMs };
      return this.continueStateMachineAfterStateCompleted(
        this.recordStateCompleted(session, state.name, output),
        state.name,
        output,
      );
    } else {
      const abortController = new AbortController();
      let resolvePromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => {
        resolvePromptStarted = resolve;
      });
      const work: Extract<ActiveStateWork, { kind: "poll" }> = {
        kind: "poll",
        session,
        state,
        promptStarted,
        resolvePromptStarted,
      };
      this.activeAbortController = abortController;
      this.activeStateWork = work;
      try {
        const command = this.renderTemplate(
          state.poll.command,
          session.stateMachine?.currentInput ?? {},
        );
        let settledShell:
          | { status: "fulfilled"; value: ShellCommandOutput }
          | { status: "rejected"; reason: unknown }
          | undefined;
        const shellPromise = this.runShellCommand(command, {
          cwd: state.poll.cwd ?? this.config.cwd ?? process.cwd(),
          signal: abortController.signal,
          successCodes: state.poll.successCodes,
        }).then(
          (value) => {
            settledShell = { status: "fulfilled", value };
            return value;
          },
          (reason) => {
            settledShell = { status: "rejected", reason };
            throw reason;
          },
        );
        shellPromise.catch(() => undefined);

        const first = await Promise.race([
          shellPromise.then(
            () => "shell" as const,
            () => "shell" as const,
          ),
          work.promptStarted.then(() => "prompt" as const),
        ]);

        if (first === "prompt") {
          const promptTerminal = await work.promptTerminal;
          if (!promptTerminal) {
            return this.sleep(session, state);
          }
          if (!settledShell) {
            abortController.abort();
            return promptTerminal;
          }
          if (settledShell.status === "rejected") {
            return promptTerminal;
          }
          return this.completePollStateAfterShellResult(
            { ...promptTerminal.state, status: "running" },
            state,
            settledShell.value,
          );
        }

        if (work.promptTerminal) {
          const promptTerminal = await work.promptTerminal;
          if (settledShell?.status === "fulfilled") {
            return this.completePollStateAfterShellResult(
              { ...promptTerminal.state, status: "running" },
              state,
              settledShell.value,
            );
          }
          return promptTerminal;
        }

        if (settledShell?.status === "fulfilled") {
          return this.completePollStateAfterShellResult(session, state, settledShell.value);
        }
      } catch {
        if (this.interruptedTerminal) {
          const terminal = this.interruptedTerminal;
          this.interruptedTerminal = undefined;
          return terminal;
        }
        // A poll with no result sleeps; failures can be modeled by the script output.
      } finally {
        if (this.activeAbortController === abortController) {
          this.activeAbortController = undefined;
        }
        if (this.activeStateWork === work) {
          this.activeStateWork = undefined;
        }
      }
    }

    return this.sleep(session, state);
  }

  private completePollStateAfterShellResult(
    session: TurnState,
    state: StateMachinePollState,
    shellOutput: ShellCommandOutput,
  ): Promise<TurnTerminalEvent> | TurnTerminalEvent {
    const { stdout } = shellOutput;
    const output = this.parseJsonObject(stdout);
    if (Object.keys(output).length === 0) {
      return this.sleep(session, state);
    }

    const rawOutput = {
      ...shellOutput,
      stdout: stdout.trim(),
      stderr: shellOutput.stderr.trim(),
      parsed: output,
    };
    return this.continueStateMachineAfterStateCompleted(
      this.recordStateCompleted(session, state.name, rawOutput),
      state.name,
      rawOutput,
    );
  }

  private sleep(session: TurnState, state: StateMachinePollState): TurnTerminalEvent {
    return {
      type: "sleep",
      wakeAt: Date.now() + state.intervalMs,
      state: { ...session, status: "sleeping" },
    };
  }

  private restoreSleepAfterPromptIfNeeded(
    originalState: TurnState,
    terminal: TurnTerminalEvent,
  ): TurnTerminalEvent {
    if (
      originalState.status !== "sleeping" ||
      terminal.type !== "complete" ||
      !this.isWaitingOnPoll(terminal.state)
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

    const state = this.currentPollState(terminal.state);
    return {
      type: "sleep",
      wakeAt: Date.now() + (state?.intervalMs ?? 0),
      state: { ...terminal.state, status: "sleeping" },
    };
  }

  protected async runStateMachineTerminalState(
    session: TurnState,
    state: StateMachineTerminalState,
  ): Promise<TurnTerminalEvent> {
    const terminal = { state: state.name, status: state.status, reason: state.reason };
    const stateMachine = session.stateMachine
      ? {
          ...session.stateMachine,
          terminal,
          history: [
            ...session.stateMachine.history,
            { type: "session_completed" as const, timestamp: Date.now(), terminal },
          ],
        }
      : undefined;

    return this.complete({ ...session, stateMachine }, state.status, state.reason);
  }

  protected async continueStateMachineAfterStateCompleted(
    session: TurnState,
    state: string,
    output?: unknown,
  ): Promise<TurnTerminalEvent> {
    if (session.mode === "agent") {
      return this.complete(session, "completed", typeof output === "string" ? output : undefined);
    }

    if (!this.drainingQueuedCommandsBeforeContinuation && this.queuedTurnCommands.length > 0) {
      this.drainingQueuedCommandsBeforeContinuation = true;
      try {
        const terminal = await this.drainQueuedTurnCommands({
          type: "complete",
          status: "completed",
          state: session,
        });
        if (terminal.type !== "complete" || terminal.status !== "completed") {
          return terminal;
        }
        session = terminal.state;
      } finally {
        this.drainingQueuedCommandsBeforeContinuation = false;
      }
    }

    let nextSession = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? ""
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;

      const workerResult = await this.runAgentWorkerWithUsage({
        state: nextSession,
        prompt: dedent`
          The state "${state}" finished.

          ${toXML({
            state_completed: {
              output: output ?? null,
            },
          })}

          ${retryInstruction}

          You must call the select_state_machine_state tool to choose the next state, terminal state, or failure outcome.
          Do not answer normally. Do not return text instead of calling the tool.
        `,
        appendSystemPrompt: createStateMachineSystemPromptLayer({ mode: session.mode, session }),
        ...this.createTools(session.mode, session),
      });

      nextSession = workerResult.terminal.state;
      if (workerResult.control.type === "ask_user_question") {
        return this.askUserQuestion(workerResult.terminal, workerResult.control);
      }

      if (workerResult.control.type === "select_state_machine_state") {
        return this.runStateMachine(nextSession, workerResult.control.decision);
      }

      if (workerResult.control.type === "create_state_machine_definition") {
        return this.complete(
          nextSession,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }
    }

    return this.complete(
      nextSession,
      "failed",
      undefined,
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  private createInitialState(mode: TurnMode): TurnState {
    return {
      status: "running",
      mode,
      agent: {
        status: "running",
        messages: [],
      },
    };
  }

  private initializeStateMachineState(
    session: TurnState,
    prompt: string,
    definition: StateMachineDefinition,
    currentState: string,
  ): TurnState {
    const now = Date.now();
    return {
      ...session,
      status: "running",
      stateMachine: {
        definition,
        prompt,
        currentState,
        history: [{ type: "session_started", timestamp: now }],
        createdAt: now,
        updatedAt: now,
      },
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
    if (!usage) return;
    const normalized = this.normalizeUsage(usage);
    const current = this.turnUsage ?? { inputTokens: 0, outputTokens: 0 };
    current.inputTokens += normalized.inputTokens;
    current.outputTokens += normalized.outputTokens;
    if (normalized.cachedInputTokens !== undefined) {
      current.cachedInputTokens = (current.cachedInputTokens ?? 0) + normalized.cachedInputTokens;
    }
    if (normalized.costUsd !== undefined) {
      current.costUsd = (current.costUsd ?? 0) + normalized.costUsd;
    }
    this.turnUsage = current;
  }

  private normalizeUsage(usage: TurnTokenUsage | Usage): TurnTokenUsage {
    if ("inputTokens" in usage) return usage;
    return {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cacheRead,
      costUsd: usage.cost.total,
    };
  }

  private usageFromMessages(messages: readonly AgentMessage[]): TurnTokenUsage | undefined {
    const usage: TurnTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let hasUsage = false;

    for (const message of messages) {
      if (!this.isAssistantMessageWithUsage(message)) continue;
      hasUsage = true;
      usage.inputTokens += message.usage.input;
      usage.outputTokens += message.usage.output;
      usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + message.usage.cacheRead;
      usage.costUsd = (usage.costUsd ?? 0) + message.usage.cost.total;
    }

    return hasUsage ? usage : undefined;
  }

  private isAssistantMessageWithUsage(
    message: AgentMessage,
  ): message is AgentMessage & { usage: Usage } {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant" &&
      "usage" in message &&
      typeof message.usage === "object" &&
      message.usage !== null
    );
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
    if (event.type === "message_start" && event.message.role === "user") {
      this.removeFollowUpPrompt(this.agentMessageText(event.message));
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_end") {
        this.emit({ type: "step", step: { type: "text", text: update.content } });
      }
      if (update.type === "thinking_end") {
        this.emit({ type: "step", step: { type: "reasoning", text: update.content } });
      }
    }
    if (event.type === "tool_execution_start") {
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          status: "running",
          input: event.args,
        },
      });
    }
    if (event.type === "tool_execution_end") {
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          status: event.isError ? "error" : "completed",
          output: event.result?.content,
        },
      });
    }
  }

  private agentMessageText(message: AgentMessage): string {
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .flatMap((part) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("\n");
  }

  private findState(session: StateMachineSession, name: string): StateMachineState | undefined {
    return session.definition.states.find((state) => state.name === name);
  }

  private isWaitingOnPoll(state: TurnState | undefined): boolean {
    return Boolean(this.currentPollState(state) && !state?.stateMachine?.terminal);
  }

  private currentPollState(state: TurnState | undefined): StateMachinePollState | undefined {
    const stateMachine = state?.stateMachine;
    const currentState = stateMachine?.currentState;
    if (!stateMachine || !currentState) return undefined;
    const definitionState = this.findState(stateMachine, currentState);
    return definitionState?.kind === "poll" ? definitionState : undefined;
  }

  private appendUserMessage(session: TurnState, text: string): TurnState {
    return {
      ...session,
      agent: {
        ...session.agent,
        messages: [
          ...session.agent.messages,
          { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        ],
      },
    };
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

  private recordStateStarted(
    session: TurnState,
    state: StateMachineState,
    input?: Record<string, unknown>,
  ): TurnState {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        currentState: state.name,
        currentInput: input,
        history: [
          ...stateMachine.history,
          {
            type: "state_started",
            timestamp: Date.now(),
            state: state.name,
            input,
          },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private recordStateCompleted(session: TurnState, state: string, output: unknown): TurnState {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        history: [
          ...stateMachine.history,
          { type: "state_completed", timestamp: Date.now(), state, output },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private elapsedSinceStateStarted(session: TurnState, state: string): number {
    const history = session.stateMachine?.history ?? [];
    for (let index = history.length - 1; index >= 0; index--) {
      const event = history[index];
      if (event.type === "state_started" && event.state === state) {
        return Math.max(0, Date.now() - event.timestamp);
      }
    }
    return 0;
  }

  private recordStateFailed(session: TurnState, state: string, error: string): TurnState {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        history: [
          ...stateMachine.history,
          { type: "state_failed", timestamp: Date.now(), state, error },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private recordStateInterrupted(session: TurnState, reason?: string): TurnState {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    const terminal = { state: "interrupted", status: "cancelled" as const, reason };
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        terminal,
        history: [
          ...stateMachine.history,
          { type: "session_completed" as const, timestamp: Date.now(), terminal },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private async runShellCommand(
    command: string,
    options: {
      cwd: string;
      timeoutMs?: number;
      signal: AbortSignal;
      successCodes?: number[];
    },
  ): Promise<ShellCommandOutput> {
    try {
      const result = await execFileAsync("sh", ["-lc", command], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        signal: options.signal,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const execError = error as ExecException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      const code =
        typeof execError.code === "number"
          ? execError.code
          : typeof execError.code === "string"
            ? Number(execError.code)
            : undefined;
      if (code !== undefined && (options.successCodes ?? [0]).includes(code)) {
        return {
          stdout: execError.stdout ?? "",
          stderr: execError.stderr ?? "",
          exitCode: code,
        };
      }
      throw error;
    }
  }

  private parseStructuredOutput(stdout: string): Record<string, unknown> {
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { result: parsed };
    } catch {
      return { result: trimmed };
    }
  }

  private parseJsonObject(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private renderTemplate(template: string, input: Record<string, unknown>): string {
    return template.replace(/\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
      const value = this.readPath(input, path);
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }

  private readPath(input: Record<string, unknown>, path: string): unknown {
    let value: unknown = input;
    for (const part of path.split(".")) {
      if (!value || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }
}
