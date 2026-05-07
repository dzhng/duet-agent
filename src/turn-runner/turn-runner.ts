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
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineTerminalState,
} from "../types/state-machine.js";
import { agentEventToTurnEvents, agentMessageText } from "./agent-events.js";
import { createStateMachineSystemPromptLayer } from "./prompts.js";
import {
  applyStateOverride,
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  isTurnRunnerControlResult,
  type StateMachineRunnerDecision,
  type TurnRunnerControlResult,
} from "./tools.js";
import { SkillContext } from "./skill-context.js";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
  runShellCommand,
  type ShellCommandOutput,
} from "./shell-exec.js";
import {
  createStateMachineSession,
  currentPollState,
  elapsedSinceStateStarted,
  findState,
  isWaitingOnPoll,
  recordRunnerDecision,
  recordStateCompleted,
  recordStateFailed,
  recordStateInterrupted,
  recordStateMachineCompleted,
  recordStateStarted,
} from "./state-machine-session.js";
import {
  appendChildUserMessage,
  completeTurn,
  copyOptionalArray,
  createInitialTurnState,
  sleepPollState,
  withStateMachine,
} from "./turn-state.js";
import { addUsage, usageFromMessages } from "./usage-accounting.js";

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

type ActiveAgentSlot = "parent" | "state_machine_child";

type ActiveStateWork =
  | { kind: "script" }
  | {
      kind: "poll";
      turnState: TurnState;
      state: StateMachinePollState;
      promptStarted: Promise<void>;
      resolvePromptStarted: () => void;
      promptTerminal?: Promise<TurnTerminalEvent>;
    };

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
  /** Latest runner-owned state, hydrated by start() and advanced by terminal events. */
  private state?: TurnState;
  /** True after `start()` has emitted the initial `turn_started` event. */
  private started = false;
  /** Aggregates model usage across parent agents, child agents, and memory work for one turn chain. */
  private turnUsage?: TurnTokenUsage;
  /** Prevents queued user prompts from recursively preempting continuation prompts. */
  private drainingQueuedCommandsBeforeContinuation = false;
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
  private readonly skillContext: SkillContext;

  constructor(readonly config: TurnRunnerConfig) {
    this.skillContext = new SkillContext(config);
  }

  async dispose(): Promise<void> {
    this.activeAgent?.clearAllQueues();
    this.activeChildAgent?.clearAllQueues();
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
    const state = command.state
      ? {
          ...command.state,
          options: this.resolveTurnOptions(command.options, command.state.options),
        }
      : createInitialTurnState(mode, this.resolveTurnOptions(command.options));
    this.setState(state);
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
    while (this.getQueuedCommands().length > 0) {
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

  private runPromptDuringActivePoll(
    work: Extract<ActiveStateWork, { kind: "poll" }>,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): void {
    if (work.promptTerminal) {
      this.enqueueTurnCommand(command);
      return;
    }

    this.setState({ ...work.turnState, status: "running" });
    work.promptTerminal = this.prompt({
      type: "prompt",
      message: this.commandToUserMessage(command),
      behavior: command.behavior,
      options: command.options,
    }).then((terminal) => this.restorePollSleepAfterMidPollPrompt(work, terminal));
    work.resolvePromptStarted();
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
    this.activeAgent?.clearFollowUpQueue();
    for (const prompt of this.getFollowUpQueue()) {
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
    const interruptedState = withStateMachine(this.state, (stateMachine) =>
      recordStateInterrupted(stateMachine, "Interrupted"),
    );
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {
        ...interruptedState,
        status: "interrupted",
        agent: { ...interruptedState.agent, status: "cancelled" },
      },
    };
    this.setState(terminal.state);
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
    this.setQueuedCommands([]);
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

    return this.restoreSleepAfterPromptIfNeeded(originalState, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = this.commandToUserMessage(command);

    const currentRunnerState = this.requireRunnerState();
    const stateMachine = currentRunnerState.stateMachine;
    const currentState = stateMachine?.currentState
      ? findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (currentRunnerState.status === "waiting_for_human" && currentState?.kind === "agent") {
      const state = appendChildUserMessage({ ...currentRunnerState, status: "running" }, message);
      return this.runAgentState(state, currentState);
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
      ? findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (originalState.status === "sleeping" && currentState?.kind === "poll") {
      return this.runPollState(state, currentState, { woke: true });
    }

    return {
      type: "complete",
      status: "completed",
      state: originalState,
      result: "Nothing to wake.",
    };
  }

  private async runStateMachineState(
    turnState: TurnState,
    decision: StateMachineRunnerDecision,
  ): Promise<TurnTerminalEvent> {
    const stateMachine = turnState.stateMachine;
    if (!stateMachine) {
      return completeTurn(turnState, "failed", undefined, "No state machine is active.");
    }

    const decidedStateMachine = recordRunnerDecision(stateMachine, decision);
    const decidedState: TurnState = {
      ...turnState,
      stateMachine: decidedStateMachine,
    };

    if (decision.kind === "fail") {
      return completeTurn(decidedState, "failed", undefined, decision.reason);
    }

    const selectedState = findState(decidedStateMachine, decision.state);
    if (!selectedState) {
      const validStates = decidedStateMachine.definition.states.map((state) => state.name);
      return completeTurn(
        decidedState,
        "failed",
        undefined,
        `Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`,
      );
    }

    const effectiveState =
      decision.kind === "run_state"
        ? applyStateOverride(selectedState, decision.override)
        : selectedState;
    const nextTurnState: TurnState = {
      ...decidedState,
      stateMachine: recordStateStarted(
        decidedStateMachine,
        effectiveState,
        decision.kind === "run_state" ? decision.input : undefined,
      ),
    };

    this.emit({ type: "state_machine", currentState: effectiveState.name });
    this.setState(nextTurnState);

    switch (effectiveState.kind) {
      case "agent":
        return this.runAgentState(nextTurnState, effectiveState);
      case "script":
        return this.runScriptState(nextTurnState, effectiveState);
      case "poll":
        return this.runPollState(nextTurnState, effectiveState);
      case "terminal":
        return this.runTerminalState(nextTurnState, effectiveState);
    }
  }

  private async runAgentState(
    turnState: TurnState,
    state: StateMachineAgentState,
  ): Promise<TurnTerminalEvent> {
    const childPrompt = renderTemplate(state.prompt, turnState.stateMachine?.currentInput ?? {});
    return this.runAgentStatePrompt(turnState, state, childPrompt);
  }

  private async promptStateMachineAgent(
    turnState: TurnState,
    prompt: string,
  ): Promise<TurnTerminalEvent> {
    const stateMachine = turnState.stateMachine;
    const currentState = stateMachine?.currentState
      ? findState(stateMachine, stateMachine.currentState)
      : undefined;
    if (!stateMachine || currentState?.kind !== "agent") {
      return completeTurn(
        turnState,
        "failed",
        undefined,
        "Cannot prompt state-machine agent because the current state is not an agent state.",
      );
    }
    return this.runAgentStatePrompt(turnState, currentState, prompt);
  }

  private async runAgentStatePrompt(
    turnState: TurnState,
    state: StateMachineAgentState,
    prompt: string,
  ): Promise<TurnTerminalEvent> {
    const childState: TurnState = {
      status: "running",
      mode: "agent",
      options: turnState.options,
      agent: turnState.childAgent
        ? { ...turnState.childAgent, status: "running" }
        : { status: "running", messages: [] },
    };
    const childWorkerResult = await this.runAgentWorkerWithUsage(
      {
        state: childState,
        prompt,
        appendSystemPrompt: state.systemPrompt,
        skills: this.skillContext.resolveStateAgentSkills(state),
        ...this.createTools("agent"),
      },
      "state_machine_child",
    );
    const childResult = childWorkerResult.terminal;
    const parentState = { ...turnState, childAgent: childResult.state.agent };
    const rawOutput = {
      result: childResult.type === "complete" ? childResult.result : undefined,
      childStatus: childResult.state.status,
      terminal: childResult,
    };
    const updatedState = withStateMachine(parentState, (stateMachine) =>
      recordStateCompleted(stateMachine, state.name, rawOutput),
    );

    if (childResult.type === "ask") {
      return { ...childResult, state: { ...updatedState, status: "waiting_for_human" } };
    }
    if (childResult.type === "sleep") {
      return { ...childResult, state: { ...updatedState, status: "sleeping" } };
    }
    if (childResult.type === "interrupted") {
      return { ...childResult, state: { ...updatedState, status: "interrupted" } };
    }

    return this.continueAfterStateCompleted(
      { ...updatedState, status: "running" },
      state.name,
      rawOutput,
    );
  }

  private async runScriptState(
    turnState: TurnState,
    state: StateMachineScriptState,
  ): Promise<TurnTerminalEvent> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeStateWork = { kind: "script" };
    try {
      const command = renderTemplate(state.command, turnState.stateMachine?.currentInput ?? {});
      const shellOutput = await runShellCommand(command, {
        cwd: state.cwd ?? this.config.cwd ?? process.cwd(),
        timeoutMs: state.timeoutMs,
        signal: abortController.signal,
        successCodes: state.successCodes,
      });
      const { stdout } = shellOutput;
      const output = parseStructuredOutput(stdout);
      const rawOutput = {
        ...shellOutput,
        stdout: stdout.trim(),
        stderr: shellOutput.stderr.trim(),
        parsed: output,
      };
      return this.continueAfterStateCompleted(
        withStateMachine(turnState, (stateMachine) =>
          recordStateCompleted(stateMachine, state.name, rawOutput),
        ),
        state.name,
        rawOutput,
      );
    } catch (error) {
      const interrupted = this.consumeInterruptedTerminal();
      if (interrupted) return interrupted;
      const message = error instanceof Error ? error.message : String(error);
      return completeTurn(
        withStateMachine(turnState, (stateMachine) =>
          recordStateFailed(stateMachine, state.name, message),
        ),
        "failed",
        undefined,
        message,
      );
    } finally {
      this.activeAbortController = undefined;
      this.activeStateWork = undefined;
    }
  }

  private async runPollState(
    turnState: TurnState,
    state: StateMachinePollState,
    options?: { woke?: boolean },
  ): Promise<TurnTerminalEvent> {
    const elapsedMs = elapsedSinceStateStarted(turnState.stateMachine, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      return completeTurn(
        withStateMachine(turnState, (stateMachine) =>
          recordStateFailed(stateMachine, state.name, message),
        ),
        "failed",
        undefined,
        message,
      );
    }

    if (state.poll.kind === "timer") {
      if (!options?.woke) {
        return sleepPollState(turnState, state);
      }
      const output = { elapsedMs };
      return this.continueAfterStateCompleted(
        withStateMachine(turnState, (stateMachine) =>
          recordStateCompleted(stateMachine, state.name, output),
        ),
        state.name,
        output,
      );
    }

    const abortController = new AbortController();
    let resolvePromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    const work: Extract<ActiveStateWork, { kind: "poll" }> = {
      kind: "poll",
      turnState,
      state,
      promptStarted,
      resolvePromptStarted,
    };
    this.activeAbortController = abortController;
    this.activeStateWork = work;
    try {
      const command = renderTemplate(
        state.poll.command,
        turnState.stateMachine?.currentInput ?? {},
      );
      let settledShell:
        | { status: "fulfilled"; value: ShellCommandOutput }
        | { status: "rejected"; reason: unknown }
        | undefined;
      const shellPromise = runShellCommand(command, {
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
          return sleepPollState(turnState, state);
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
        return this.completePollStateAfterShellResult(turnState, state, settledShell.value);
      }
    } catch {
      const interrupted = this.consumeInterruptedTerminal();
      if (interrupted) return interrupted;
    } finally {
      this.activeAbortController = undefined;
      this.activeStateWork = undefined;
    }

    return sleepPollState(turnState, state);
  }

  private restorePollSleepAfterMidPollPrompt(
    work: Extract<ActiveStateWork, { kind: "poll" }>,
    terminal: TurnTerminalEvent,
  ): TurnTerminalEvent {
    if (terminal.type !== "complete" || terminal.status !== "completed") {
      return terminal;
    }

    const currentPoll = currentPollState(terminal.state.stateMachine);
    if (!currentPoll || currentPoll.name !== work.state.name) {
      return terminal;
    }

    return sleepPollState(terminal.state, currentPoll);
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

  private async runTerminalState(
    turnState: TurnState,
    state: StateMachineTerminalState,
  ): Promise<TurnTerminalEvent> {
    const terminal = { state: state.name, status: state.status, reason: state.reason };
    const stateMachine = turnState.stateMachine
      ? recordStateMachineCompleted(turnState.stateMachine, terminal)
      : undefined;

    return completeTurn({ ...turnState, stateMachine }, state.status, state.reason);
  }

  private async continueAfterStateCompleted(
    turnState: TurnState,
    state: string,
    output?: unknown,
  ): Promise<TurnTerminalEvent> {
    if (turnState.mode === "agent") {
      return completeTurn(turnState, "completed", typeof output === "string" ? output : undefined);
    }

    if (!this.drainingQueuedCommandsBeforeContinuation && this.getQueuedCommands().length > 0) {
      this.drainingQueuedCommandsBeforeContinuation = true;
      try {
        const terminal = await this.drainQueuedTurnCommands({
          type: "complete",
          status: "completed",
          state: turnState,
        });
        if (terminal.type !== "complete" || terminal.status !== "completed") {
          return terminal;
        }
        turnState = terminal.state;
      } finally {
        this.drainingQueuedCommandsBeforeContinuation = false;
      }
    }

    let nextTurnState = turnState;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? ""
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;

      const workerResult = await this.runAgentWorkerWithUsage({
        state: nextTurnState,
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
        appendSystemPrompt: createStateMachineSystemPromptLayer({
          mode: turnState.mode,
          session: turnState,
        }),
        ...this.createTools(turnState.mode, turnState),
      });

      nextTurnState = workerResult.terminal.state;
      if (workerResult.control.type === "ask_user_question") {
        return this.askUserQuestion(workerResult.terminal, workerResult.control);
      }

      if (workerResult.control.type === "select_state_machine_state") {
        return this.runStateMachineState(nextTurnState, workerResult.control.decision);
      }

      if (workerResult.control.type === "create_state_machine_definition") {
        return completeTurn(
          nextTurnState,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }
    }

    return completeTurn(
      nextTurnState,
      "failed",
      undefined,
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  private initializeState(
    turnState: TurnState,
    prompt: string,
    definition: StateMachineDefinition,
    currentState: string,
  ): TurnState {
    return {
      ...turnState,
      status: "running",
      stateMachine: createStateMachineSession(prompt, definition, currentState),
    };
  }

  private completePollStateAfterShellResult(
    turnState: TurnState,
    state: StateMachinePollState,
    shellOutput: ShellCommandOutput,
  ): Promise<TurnTerminalEvent> | TurnTerminalEvent {
    const { stdout } = shellOutput;
    const output = parseJsonObject(stdout);
    if (Object.keys(output).length === 0) {
      return sleepPollState(turnState, state);
    }

    const rawOutput = {
      ...shellOutput,
      stdout: stdout.trim(),
      stderr: shellOutput.stderr.trim(),
      parsed: output,
    };
    return this.continueAfterStateCompleted(
      withStateMachine(turnState, (stateMachine) =>
        recordStateCompleted(stateMachine, state.name, rawOutput),
      ),
      state.name,
      rawOutput,
    );
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
    const parentAgent = this.activeAgent
      ? {
          ...state.agent,
          status: state.agent.status,
          messages: this.activeAgent.state.messages,
        }
      : state.agent;
    const childAgent = this.activeChildAgent
      ? {
          status: state.childAgent?.status ?? "running",
          messages: this.activeChildAgent.state.messages,
        }
      : state.childAgent;
    return {
      ...state,
      agent: parentAgent,
      ...(childAgent ? { childAgent } : {}),
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
        return completeTurn(
          workerResult.terminal.state,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }

      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      const state = this.initializeState(
        workerResult.terminal.state,
        input.prompt,
        workerResult.control.definition,
        firstState,
      );
      return this.runStateMachineState(state, { kind: "run_state", state: firstState });
    }

    if (workerResult.control.type === "prompt_state_machine_agent") {
      return this.promptStateMachineAgent(workerResult.terminal.state, workerResult.control.prompt);
    }

    if (workerResult.control.type !== "select_state_machine_state") {
      return completeTurn(
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
        ? this.initializeState(
            workerResult.terminal.state,
            input.prompt,
            input.mode,
            workerResult.control.decision.state,
          )
        : workerResult.terminal.state;
    return this.runStateMachineState(selectedState, workerResult.control.decision);
  }

  protected createTools(
    mode: TurnMode,
    session?: TurnState,
  ): {
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
        definition: session?.stateMachine?.definition,
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
    if (this.getActiveAgent(activeSlot)) {
      const description = this.activeAgentDescription(activeSlot);
      throw new Error(`Cannot start a ${description} while another ${description} is active.`);
    }

    let control: TurnRunnerControlResult = { type: "none" };
    const agent = this.createAgent(input, (result) => {
      control = result;
    });
    this.setActiveAgent(activeSlot, agent);

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
      this.setActiveAgent(activeSlot, undefined);
    }

    const interrupted = interruptedDuringPrompt ?? this.consumeInterruptedTerminal();
    if (interrupted) {
      return { control, terminal: interrupted };
    }

    const messages = agent.state.messages;
    const usage = usageFromMessages(messages.slice(input.state.agent.messages.length));
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

  private getActiveAgent(slot: ActiveAgentSlot): Agent | undefined {
    return slot === "parent" ? this.activeAgent : this.activeChildAgent;
  }

  private setActiveAgent(slot: ActiveAgentSlot, agent: Agent | undefined): void {
    if (slot === "parent") {
      this.activeAgent = agent;
      if (agent) this.replayFollowUpQueueIntoAgent(agent);
    } else {
      this.activeChildAgent = agent;
    }
    this.snapshotActiveAgentState();
  }

  private activeAgentDescription(slot: ActiveAgentSlot): string {
    return slot === "parent" ? "parent agent" : "state-machine child agent";
  }

  private async runAgentWorkerWithUsage(
    input: AgentWorkerInput,
    activeSlot: ActiveAgentSlot = "parent",
  ): Promise<AgentWorkerResult> {
    const result = await this.runAgentWorker(
      { ...input, state: this.withRuntimeOptions(input.state, input.options) },
      activeSlot,
    );
    this.recordUsage(result.terminal.usage);
    return result;
  }

  protected createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const options = this.resolveTurnOptions(input.options, input.state.options);
    const model = this.resolveTurnModel(options);
    const memoryModel = this.resolveMemoryModel(options);
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

  private withRuntimeOptions(state: TurnState, options?: TurnOptions): TurnState {
    return {
      ...state,
      options: this.resolveTurnOptions(options, state.options),
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
