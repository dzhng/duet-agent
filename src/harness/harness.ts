import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, type Model } from "@mariozechner/pi-ai";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assistantText } from "../core/serializer.js";
import { toXML } from "../lib/xml.js";
import { createObservationalMemoryTransform } from "../memory/observational.js";
import { loadStoredMemory } from "../memory/storage.js";
import { MemoryStore } from "../memory/store.js";
import type { HarnessConfig } from "../types/config.js";
import type {
  HarnessAnswerCommand,
  HarnessEvent,
  HarnessInterruptCommand,
  HarnessMode,
  HarnessPromptCommand,
  HarnessSession,
  HarnessStartCommand,
  HarnessTerminalStatus,
  HarnessTerminalTurnEvent,
  HarnessTurnCommand,
  HarnessTurnOptions,
  HarnessWakeCommand,
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
  createStateAgentPrompt,
  createStateAgentSystemPromptLayer,
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
  createDefaultHarnessTools,
  createHarnessTools,
  type HarnessControlResult,
  type StateMachineRunnerDecision,
} from "./tools.js";

const execFileAsync = promisify(execFile);

export type HarnessEventHandler = (event: HarnessEvent) => void;

export interface AgentWorkerInput {
  session: HarnessSession;
  prompt: string;
  options?: HarnessTurnOptions;
  appendSystemPrompt?: string;
  tools: AgentTool[];
}

export interface AgentWorkerResult {
  terminal: HarnessTerminalTurnEvent;
  control: HarnessControlResult;
}

export class Harness {
  private readonly eventHandlers = new Set<HarnessEventHandler>();
  protected readonly memory = new MemoryStore();
  private memoryStorageDispose?: () => Promise<void>;
  private activeAgent?: Agent;
  private interruptedTerminal?: HarnessTerminalTurnEvent;
  private skills: Skill[] = [];
  private skillsLoaded = false;
  private memoryLoaded = false;

  constructor(readonly config: HarnessConfig) {
    if (config.skills) {
      this.skills = prepareExplicitSkills(config.skills);
    }
  }

  async dispose(): Promise<void> {
    await this.memoryStorageDispose?.();
    this.memoryStorageDispose = undefined;
  }

  subscribe(handler: HarnessEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async turn(command: HarnessTurnCommand): Promise<HarnessTerminalTurnEvent> {
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    this.emit({ type: "ready" });
    let terminal: HarnessTerminalTurnEvent;
    switch (command.type) {
      case "start":
        terminal = await this.start(command);
        break;
      case "prompt":
        terminal = await this.prompt(command);
        break;
      case "answer":
        terminal = await this.answer(command);
        break;
      case "wake":
        terminal = await this.wake(command);
        break;
    }
    this.emit(terminal);
    return terminal;
  }

  interrupt(command: HarnessInterruptCommand): void {
    const terminal: HarnessTerminalTurnEvent = {
      type: "interrupted",
      session: {
        ...command.session,
        status: "interrupted",
        agent: { ...command.session.agent, status: "cancelled" },
      },
    };
    if (this.activeAgent) {
      // The active turn emits this terminal event after agent.prompt() unwinds.
      // interrupt() only aborts out-of-band; it does not own turn completion.
      this.interruptedTerminal = terminal;
    }
    this.activeAgent?.abort();
    this.activeAgent = undefined;
  }

  protected emit(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  protected async start(command: HarnessStartCommand): Promise<HarnessTerminalTurnEvent> {
    const mode = command.mode ?? this.config.mode ?? "auto";
    const session = this.createInitialSession(mode);
    this.emit({ type: "session_started", session });

    if (mode === "agent") {
      return this.runAgentMode(session, command.prompt, command.options);
    }

    return this.runHarnessAgentWithStateMachineTools({
      session,
      prompt: command.prompt,
      mode,
      options: command.options,
    });
  }

  protected async prompt(command: HarnessPromptCommand): Promise<HarnessTerminalTurnEvent> {
    const session: HarnessSession = { ...command.session, status: "running" };
    if (session.mode === "agent") {
      return this.runAgentMode(session, command.message, command.options);
    }

    return this.runHarnessAgentWithStateMachineTools({
      session,
      prompt: command.message,
      mode: session.mode,
      options: command.options,
    });
  }

  protected async answer(command: HarnessAnswerCommand): Promise<HarnessTerminalTurnEvent> {
    const message = dedent`
      Here are my answers to your questions.

      ${toXML([{ questions: command.questions }, { answers: command.answers }])}
    `;

    const stateMachine = command.session.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.session.status === "waiting_for_human" && currentState?.kind === "agent") {
      const session = this.appendUserMessage({ ...command.session, status: "running" }, message);
      return this.runStateMachineAgentState(session, currentState);
    }

    return this.prompt({
      type: "prompt",
      session: command.session,
      message,
      behavior: command.behavior,
      options: command.options,
    });
  }

  protected async wake(command: HarnessWakeCommand): Promise<HarnessTerminalTurnEvent> {
    const session: HarnessSession = { ...command.session, status: "running" };
    const stateMachine = session.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;

    if (command.session.status === "sleeping" && currentState?.kind === "poll") {
      return this.runStateMachinePollState(session, currentState);
    }

    return {
      type: "complete",
      status: "completed",
      session: command.session,
      result: "Nothing to wake.",
    };
  }

  protected async runHarnessAgentWithStateMachineTools(input: {
    session: HarnessSession;
    prompt: string;
    mode: Exclude<HarnessMode, "agent">;
    options?: HarnessTurnOptions;
  }): Promise<HarnessTerminalTurnEvent> {
    const workerResult = await this.runAgentWorker({
      session: input.session,
      prompt: input.prompt,
      options: input.options,
      appendSystemPrompt: createStateMachineSystemPromptLayer({
        mode: input.mode,
        session: input.session,
      }),
      ...this.createTools(input.mode, input.session),
    });

    if (workerResult.control.type === "none") {
      return workerResult.terminal;
    }

    if (workerResult.control.type === "create_state_machine_definition") {
      if (
        workerResult.terminal.session.stateMachine &&
        !workerResult.terminal.session.stateMachine.terminal
      ) {
        return this.complete(
          workerResult.terminal.session,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }

      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      const session = this.initializeStateMachineSession(
        workerResult.terminal.session,
        input.prompt,
        workerResult.control.definition,
        firstState,
      );
      return this.runStateMachine(session, { kind: "run_state", state: firstState });
    }

    const selectedSession =
      !workerResult.terminal.session.stateMachine &&
      typeof input.mode === "object" &&
      workerResult.control.decision.kind !== "fail"
        ? this.initializeStateMachineSession(
            workerResult.terminal.session,
            input.prompt,
            input.mode,
            workerResult.control.decision.state,
          )
        : workerResult.terminal.session;
    return this.runStateMachine(selectedSession, workerResult.control.decision);
  }

  protected createTools(
    mode: HarnessMode,
    session?: HarnessSession,
  ): {
    tools: AgentTool[];
  } {
    const cwd = this.config.cwd ?? process.cwd();
    if (mode === "agent") {
      return { tools: createDefaultHarnessTools(cwd) };
    }

    return {
      tools: createHarnessTools({ cwd, mode, definition: session?.stateMachine?.definition }),
    };
  }

  protected async runAgentMode(
    session: HarnessSession,
    prompt: string,
    options?: HarnessTurnOptions,
  ): Promise<HarnessTerminalTurnEvent> {
    return (
      await this.runAgentWorker({
        session,
        prompt,
        options,
        ...this.createTools("agent"),
      })
    ).terminal;
  }

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    let control: HarnessControlResult = { type: "none" };
    const agent = this.createAgent(input, (result) => {
      control = result;
    });
    this.activeAgent = agent;

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
      }
    }

    if (this.interruptedTerminal) {
      const terminal = this.interruptedTerminal;
      this.interruptedTerminal = undefined;
      return { control, terminal };
    }

    const messages = agent.state.messages;
    const status = agent.state.errorMessage ? "failed" : "completed";
    const session = {
      ...input.session,
      status,
      agent: {
        status,
        messages,
      },
    } satisfies HarnessSession;

    return {
      control,
      terminal: {
        type: "complete",
        status,
        session,
        result: assistantText(messages),
        error: agent.state.errorMessage,
      },
    };
  }

  protected createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: HarnessControlResult) => void,
  ): Agent {
    const model = this.resolveModel(input.options);
    return new Agent({
      initialState: {
        model,
        thinkingLevel: input.options?.thinkingLevel ?? "medium",
        systemPrompt: this.createBaseSystemPromptWithAppendedLayers(input.appendSystemPrompt),
        messages: input.session.agent.messages,
        tools: input.tools,
      },
      transformContext: this.createMemoryTransform(model),
      afterToolCall: async (context) => {
        if (this.isHarnessControlResult(context.result.details)) {
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

  protected createBaseSystemPromptWithAppendedLayers(...append: Array<string | undefined>): string {
    return createSystemPromptWithAppendedLayers({
      config: this.config,
      skills: this.skills,
      append,
    });
  }

  private isHarnessControlResult(value: unknown): value is HarnessControlResult {
    if (!value || typeof value !== "object" || !("type" in value)) return false;
    const type = value.type;
    return (
      type === "none" ||
      type === "create_state_machine_definition" ||
      type === "select_state_machine_state"
    );
  }

  protected async runStateMachine(
    session: HarnessSession,
    decision: StateMachineRunnerDecision,
  ): Promise<HarnessTerminalTurnEvent> {
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
    const nextSession = this.recordStateStarted(session, effectiveState);

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
    session: HarnessSession,
    state: StateMachineAgentState,
  ): Promise<HarnessTerminalTurnEvent> {
    const childPrompt = createStateAgentPrompt({ session, state });
    const childSession: HarnessSession = {
      ...session,
      mode: "agent",
      status: "running",
      stateMachine: undefined,
      agent: { ...session.agent, status: "running" },
    };
    const childResult = (
      await this.runAgentWorker({
        session: childSession,
        prompt: childPrompt,
        options: state.options,
        appendSystemPrompt: createStateAgentSystemPromptLayer({ session, state }),
        ...this.createTools("agent"),
      })
    ).terminal;
    const parentSession = { ...session, agent: childResult.session.agent };
    const updatedSession = this.recordStateCompleted(parentSession, state.name, {
      result: childResult.type === "complete" ? childResult.result : undefined,
      childStatus: childResult.session.status,
    });

    if (childResult.type === "ask") {
      return { ...childResult, session: { ...updatedSession, status: "waiting_for_human" } };
    }
    if (childResult.type === "sleep") {
      return { ...childResult, session: { ...updatedSession, status: "sleeping" } };
    }
    if (childResult.type === "interrupted") {
      return { ...childResult, session: { ...updatedSession, status: "interrupted" } };
    }

    return this.continueStateMachineAfterStateCompleted(
      { ...updatedSession, status: "running" },
      state.name,
      childResult.result,
    );
  }

  protected async runStateMachineScriptState(
    session: HarnessSession,
    state: StateMachineScriptState,
  ): Promise<HarnessTerminalTurnEvent> {
    try {
      const { stdout } = await execFileAsync("sh", ["-lc", state.command], {
        cwd: state.cwd ?? this.config.cwd ?? process.cwd(),
        timeout: state.timeoutMs,
      });
      const output = this.parseStructuredOutput(stdout);
      return this.continueStateMachineAfterStateCompleted(
        this.recordStateCompleted(session, state.name, output),
        state.name,
        stdout.trim(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.complete(
        this.recordStateFailed(session, state.name, message),
        "failed",
        undefined,
        message,
      );
    }
  }

  protected async runStateMachinePollState(
    session: HarnessSession,
    state: StateMachinePollState,
  ): Promise<HarnessTerminalTurnEvent> {
    if (state.poll.kind === "prompt") {
      const result = await this.runAgentMode(this.createInitialSession("agent"), state.poll.prompt);
      const output =
        result.type === "complete" && result.result ? this.parseJsonObject(result.result) : {};
      if (Object.keys(output).length > 0) {
        return this.continueStateMachineAfterStateCompleted(
          this.recordStateCompleted(session, state.name, output),
          state.name,
          result.type === "complete" ? result.result : undefined,
        );
      }
    } else {
      try {
        const { stdout } = await execFileAsync("sh", ["-lc", state.poll.command], {
          cwd: state.poll.cwd ?? this.config.cwd ?? process.cwd(),
          timeout: state.timeoutMs,
        });
        const output = this.parseJsonObject(stdout);
        if (Object.keys(output).length > 0) {
          return this.continueStateMachineAfterStateCompleted(
            this.recordStateCompleted(session, state.name, output),
            state.name,
            stdout.trim(),
          );
        }
      } catch {
        // A poll with no result sleeps; failures can be modeled by the script output.
      }
    }

    return {
      type: "sleep",
      wakeAt: Date.now() + state.intervalMs,
      session: { ...session, status: "sleeping" },
    };
  }

  protected async runStateMachineTerminalState(
    session: HarnessSession,
    state: StateMachineTerminalState,
  ): Promise<HarnessTerminalTurnEvent> {
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
    session: HarnessSession,
    state: string,
    result?: string,
  ): Promise<HarnessTerminalTurnEvent> {
    if (session.mode === "agent") {
      return this.complete(session, "completed", result);
    }

    let nextSession = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? ""
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;

      const workerResult = await this.runAgentWorker({
        session: nextSession,
        prompt: dedent`
          The state "${state}" finished.

          ${toXML({ result: result ?? "" })}

          ${retryInstruction}

          You must call the select_state_machine_state tool to choose the next state, terminal state, or failure outcome.
          Do not answer normally. Do not return text instead of calling the tool.
        `,
        appendSystemPrompt: createStateMachineSystemPromptLayer({ mode: session.mode, session }),
        ...this.createTools(session.mode, session),
      });

      nextSession = workerResult.terminal.session;

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

  private createInitialSession(mode: HarnessMode): HarnessSession {
    return {
      status: "running",
      mode,
      agent: {
        status: "running",
        messages: [],
      },
    };
  }

  private initializeStateMachineSession(
    session: HarnessSession,
    prompt: string,
    definition: StateMachineDefinition,
    currentState: string,
  ): HarnessSession {
    const now = Date.now();
    return {
      ...session,
      status: "running",
      stateMachine: {
        definition,
        prompt,
        currentState,
        state: {},
        history: [{ type: "session_started", timestamp: now }],
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  private resolveModel(options?: HarnessTurnOptions): Model<any> {
    const modelName = options?.model ?? this.config.harnessModel;
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

  private appendUserMessage(session: HarnessSession, text: string): HarnessSession {
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
    session: HarnessSession,
    status: HarnessTerminalStatus,
    result?: string,
    error?: string,
  ): HarnessTerminalTurnEvent {
    return {
      type: "complete",
      status,
      result,
      error,
      session: {
        ...session,
        status,
      },
    };
  }

  private recordStateStarted(session: HarnessSession, state: StateMachineState): HarnessSession {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        currentState: state.name,
        history: [
          ...stateMachine.history,
          {
            type: "state_started",
            timestamp: Date.now(),
            state: state.name,
            effectiveState: state,
          },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private recordStateCompleted(
    session: HarnessSession,
    state: string,
    output: unknown,
  ): HarnessSession {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        state: {
          ...stateMachine.state,
          ...(typeof output === "object" && output !== null ? output : { result: output }),
        },
        history: [
          ...stateMachine.history,
          { type: "state_completed", timestamp: Date.now(), state, output },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  private recordStateFailed(session: HarnessSession, state: string, error: string): HarnessSession {
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
}
