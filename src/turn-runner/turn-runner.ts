import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model } from "@mariozechner/pi-ai";
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
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
  TurnState,
  TurnStartCommand,
  TurnRunnerTerminalStatus,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
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
  type TurnRunnerControlResult,
  type StateMachineRunnerDecision,
} from "./tools.js";

const execFileAsync = promisify(execFile);

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  options?: TurnOptions;
  appendSystemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
  agentScope?: "parent" | "child";
}

export interface AgentWorkerResult {
  terminal: TurnTerminalEvent;
  control: TurnRunnerControlResult;
}

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
  private memoryStorageDispose?: () => Promise<void>;
  /** Current pi agent, if a model turn is active; used for out-of-band interruption. */
  private activeAgent?: Agent;
  /** Whether the active pi agent owns the parent transcript or a state-machine child turn. */
  private activeAgentScope?: "parent" | "child";
  /** Current script or poll abort controller, used to interrupt non-agent state work. */
  private activeAbortController?: AbortController;
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
    await this.memoryStorageDispose?.();
    this.memoryStorageDispose = undefined;
  }

  subscribe(handler: TurnEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
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
    this.emit({ type: "ready" });
    let terminal: TurnTerminalEvent;
    terminal = await this.executeTurnCommand(command);
    terminal = await this.drainQueuedTurnCommands(terminal);
    this.emit(terminal);
    return terminal;
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
      if (this.activeAgentScope === "child" && command.type !== "answer") {
        this.queuedTurnCommands.push(command);
        return;
      }
      const message = this.commandToUserMessage(command);
      const agentMessage = { role: "user" as const, content: message, timestamp: Date.now() };
      if (command.behavior === "steer") {
        this.activeAgent.steer(agentMessage);
      } else {
        // State-machine continuations and normal user input stay linear by
        // entering the active parent transcript as pi follow-ups.
        this.activeAgent.followUp(agentMessage);
      }
      return;
    }

    this.queuedTurnCommands.push(command);
  }

  private async drainQueuedTurnCommands(terminal: TurnTerminalEvent): Promise<TurnTerminalEvent> {
    let latest = terminal;
    while (this.queuedTurnCommands.length > 0) {
      if (
        latest.type === "interrupted" ||
        (latest.type === "complete" && latest.status === "failed")
      ) {
        this.queuedTurnCommands.length = 0;
        return latest;
      }
      const queued = this.queuedTurnCommands.shift()!;
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

  private commandToUserMessage(command: TurnPromptCommand | TurnAnswerCommand): string {
    if (command.type === "prompt") {
      return this.resolveSlashSkillPrompt(command.message);
    }

    return dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;
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
    if (this.activeAgent || this.activeAbortController) {
      // The active turn emits this terminal event after agent.prompt() unwinds.
      // interrupt() only aborts out-of-band; it does not own turn completion.
      this.interruptedTerminal = terminal;
    }
    this.activeAgent?.abort();
    this.activeAbortController?.abort();
    this.activeAgent?.clearAllQueues();
    this.queuedTurnCommands.length = 0;
    this.activeAgent = undefined;
    this.activeAgentScope = undefined;
    this.activeAbortController = undefined;
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
    const workerResult = await this.runAgentWorker({
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
    if (mode === "agent") {
      return { tools: createDefaultTurnRunnerTools(cwd) };
    }

    return {
      tools: createTurnRunnerTools({ cwd, mode, definition: session?.stateMachine?.definition }),
    };
  }

  protected async runAgentMode(
    state: TurnState,
    prompt: string,
    options?: TurnOptions,
  ): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorker({
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

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    let control: TurnRunnerControlResult = { type: "none" };
    const agent = this.createAgent(input, (result) => {
      control = result;
    });
    this.activeAgent = agent;
    this.activeAgentScope = input.agentScope ?? "parent";

    const unsubscribe = agent.subscribe((event) => this.emitAgentEvent(event));
    try {
      await agent.prompt(input.prompt);
    } catch (error) {
      if (!this.interruptedTerminal) {
        throw error;
      }
    } finally {
      unsubscribe();
      if (this.activeAgent === agent) {
        this.activeAgent = undefined;
        this.activeAgentScope = undefined;
      }
    }

    if (this.interruptedTerminal) {
      const terminal = this.interruptedTerminal;
      this.interruptedTerminal = undefined;
      return { control, terminal };
    }

    const messages = agent.state.messages;
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
      },
    };
  }

  protected createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const model = this.resolveModel(input.options);
    return new Agent({
      initialState: {
        model,
        thinkingLevel: input.options?.thinkingLevel ?? "medium",
        systemPrompt: this.createBaseSystemPromptWithAppendedLayers({
          append: [input.appendSystemPrompt],
          skills: input.skills,
        }),
        messages: input.state.agent.messages,
        tools: input.tools,
      },
      transformContext: this.createMemoryTransform(model),
      afterToolCall: async (context) => {
        if (this.isTurnRunnerControlResult(context.result.details)) {
          onControlResult?.(context.result.details);
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

    this.memoryStorageDispose = await loadStoredMemory(
      this.config.memoryStorage,
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
    const childResult = (
      await this.runAgentWorker({
        state: childState,
        prompt,
        appendSystemPrompt: state.systemPrompt,
        skills: this.resolveStateAgentSkills(state),
        agentScope: "child",
        ...this.createTools("agent"),
      })
    ).terminal;
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
      this.activeAbortController = abortController;
      try {
        const command = this.renderTemplate(
          state.poll.command,
          session.stateMachine?.currentInput ?? {},
        );
        const shellOutput = await this.runShellCommand(command, {
          cwd: state.poll.cwd ?? this.config.cwd ?? process.cwd(),
          signal: abortController.signal,
          successCodes: state.poll.successCodes,
        });
        const { stdout } = shellOutput;
        const output = this.parseJsonObject(stdout);
        if (Object.keys(output).length > 0) {
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
      }
    }

    return this.sleep(session, state);
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

    let nextSession = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? ""
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;

      const workerResult = await this.runAgentWorker({
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

  private resolveModel(options?: TurnOptions): Model<any> {
    const modelName = options?.model ?? this.config.model;
    const separator = modelName.indexOf(":");
    if (separator === -1) {
      throw new Error("Models must use provider:modelId syntax");
    }
    const provider = modelName.slice(0, separator) as Parameters<typeof getModel>[0];
    const model = modelName.slice(separator + 1) as Parameters<typeof getModel>[1];
    return getModel(provider, model);
  }

  protected emitAgentEvent(event: AgentEvent): void {
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
        },
      });
    }
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
