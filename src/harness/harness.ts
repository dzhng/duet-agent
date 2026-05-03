import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel, streamSimple, type Model } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assistantText } from "../core/serializer.js";
import type { DuetAgentConfig } from "../types/config.js";
import type {
  HarnessAnswerCommand,
  HarnessEvent,
  HarnessInterruptCommand,
  HarnessMode,
  HarnessPromptCommand,
  HarnessRun,
  HarnessRunStatus,
  HarnessStartCommand,
  HarnessTerminalStatus,
  HarnessTerminalTurnEvent,
  HarnessTurnCommand,
  HarnessTurnOptions,
} from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineRun,
  StateMachineScriptState,
  StateMachineState,
  StateMachineTerminalState,
} from "../types/state-machine.js";
import {
  applyStateOverride,
  createDefaultHarnessTools,
  createHarnessToolSet,
  type HarnessControlResult,
  type HarnessToolsResultRef,
  type StateMachineRunnerDecision,
} from "./tools.js";

const execFileAsync = promisify(execFile);

export type HarnessEventHandler = (event: HarnessEvent) => void;

export interface AgentWorkerInput {
  run: HarnessRun;
  prompt: string;
  options?: HarnessTurnOptions;
  systemPrompt?: string;
  tools: AgentTool[];
  control?: HarnessToolsResultRef;
}

export interface AgentWorkerResult {
  terminal: HarnessTerminalTurnEvent;
  control: HarnessControlResult;
}

export class Harness {
  private readonly eventHandlers = new Set<HarnessEventHandler>();
  private activeAgent?: Agent;
  private interruptedTerminal?: HarnessTerminalTurnEvent;

  constructor(readonly config: DuetAgentConfig) {}

  subscribe(handler: HarnessEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async turn(command: HarnessTurnCommand): Promise<HarnessTerminalTurnEvent> {
    this.emit({ type: "ready" });
    switch (command.type) {
      case "start":
        return this.start(command);
      case "prompt":
        return this.prompt(command);
      case "answer":
        return this.answer(command);
    }
  }

  interrupt(command: HarnessInterruptCommand): void {
    const terminal: HarnessTerminalTurnEvent = {
      type: "interrupted",
      run: {
        ...command.run,
        status: "interrupted",
        agent: { ...command.run.agent, status: "cancelled" },
      },
    };
    if (this.activeAgent) {
      this.interruptedTerminal = terminal;
    }
    this.activeAgent?.abort();
    this.activeAgent = undefined;
    this.emit(terminal);
  }

  protected emit(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  protected async start(command: HarnessStartCommand): Promise<HarnessTerminalTurnEvent> {
    const mode = command.mode ?? this.config.mode ?? "auto";
    const run = this.createInitialRun(command.prompt, mode);
    this.emit({ type: "run_started", run });

    if (mode === "agent") {
      return this.runAgentMode(run, command.prompt, command.options);
    }

    return this.runHarnessAgentWithStateMachineTools({
      run,
      prompt: command.prompt,
      mode,
      options: command.options,
    });
  }

  protected async prompt(command: HarnessPromptCommand): Promise<HarnessTerminalTurnEvent> {
    const run = this.appendUserMessage(this.withRunStatus(command.run, "running"), command.message);
    if (run.stateMachine) {
      return this.askRunnerForNextState(run, command.message, command.options);
    }

    return this.runAgentMode(run, command.message, command.options);
  }

  protected async answer(command: HarnessAnswerCommand): Promise<HarnessTerminalTurnEvent> {
    return this.prompt({
      type: "prompt",
      run: command.run,
      message: JSON.stringify({ questions: command.questions, answers: command.answers }),
      behavior: command.behavior,
      options: command.options,
    });
  }

  protected async runHarnessAgentWithStateMachineTools(input: {
    run: HarnessRun;
    prompt: string;
    mode: Exclude<HarnessMode, "agent">;
    options?: HarnessTurnOptions;
  }): Promise<HarnessTerminalTurnEvent> {
    const workerResult = await this.runAgentWorker({
      run: input.run,
      prompt: input.prompt,
      options: input.options,
      systemPrompt: this.createStateMachineSystemPrompt(input.mode),
      ...this.createTools(input.mode),
    });

    if (workerResult.control.type === "none") {
      return workerResult.terminal;
    }

    if (workerResult.control.type === "create_state_machine_definition") {
      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      const run = this.initializeStateMachineRun(
        workerResult.terminal.run,
        input.prompt,
        workerResult.control.definition,
        firstState,
      );
      return this.runStateMachine(run, { kind: "run_state", state: firstState });
    }

    const selectedRun =
      !workerResult.terminal.run.stateMachine &&
      typeof input.mode === "object" &&
      workerResult.control.decision.kind !== "fail"
        ? this.initializeStateMachineRun(
            workerResult.terminal.run,
            input.prompt,
            input.mode,
            workerResult.control.decision.state,
          )
        : workerResult.terminal.run;
    return this.runStateMachine(selectedRun, workerResult.control.decision);
  }

  protected async askRunnerForNextState(
    run: HarnessRun,
    prompt: string,
    options?: HarnessTurnOptions,
  ): Promise<HarnessTerminalTurnEvent> {
    const workerResult = await this.runAgentWorker({
      run,
      prompt,
      options,
      systemPrompt: this.createStateMachineSystemPrompt(run.mode),
      ...this.createTools(run.mode),
    });

    if (workerResult.control.type === "create_state_machine_definition") {
      if (run.mode !== "auto") {
        return this.complete(
          run,
          "failed",
          undefined,
          "Explicit state-machine mode cannot create a new definition.",
        );
      }
      const firstState =
        workerResult.control.firstState ?? workerResult.control.definition.states[0]?.name ?? "";
      return this.runStateMachine(
        this.initializeStateMachineRun(
          workerResult.terminal.run,
          prompt,
          workerResult.control.definition,
          firstState,
        ),
        { kind: "run_state", state: firstState },
      );
    }

    if (workerResult.control.type === "select_state_machine_state") {
      return this.runStateMachine(workerResult.terminal.run, workerResult.control.decision);
    }

    return workerResult.terminal;
  }

  protected createTools(mode: HarnessMode): {
    tools: AgentTool[];
    control?: HarnessToolsResultRef;
  } {
    const cwd = this.config.cwd ?? process.cwd();
    if (mode === "agent") {
      return { tools: createDefaultHarnessTools(cwd) };
    }

    const toolSet = createHarnessToolSet({ cwd, mode });
    return { tools: toolSet.tools, control: toolSet.result };
  }

  protected async runAgentMode(
    run: HarnessRun,
    prompt: string,
    options?: HarnessTurnOptions,
  ): Promise<HarnessTerminalTurnEvent> {
    return (
      await this.runAgentWorker({
        run,
        prompt,
        options,
        ...this.createTools("agent"),
      })
    ).terminal;
  }

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const controlRef = input.control ?? { current: { type: "none" } as HarnessControlResult };
    const agent = new Agent({
      initialState: {
        model: this.resolveModel(input.options),
        thinkingLevel: this.resolveThinkingLevel(input.options),
        systemPrompt: input.systemPrompt ?? this.config.systemInstructions ?? "",
        messages: input.run.agent.messages,
        tools: input.tools,
      },
      convertToLlm,
      streamFn: streamSimple,
      getApiKey: getEnvApiKey,
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
      return { control: controlRef.current, terminal };
    }

    const messages = agent.state.messages;
    const status = agent.state.errorMessage ? "failed" : "completed";
    const run = {
      ...input.run,
      status,
      agent: {
        status,
        messages,
      },
    } satisfies HarnessRun;

    return {
      control: controlRef.current,
      terminal: {
        type: "complete",
        status,
        run,
        result: assistantText(messages),
        error: agent.state.errorMessage,
      },
    };
  }

  protected async runStateMachine(
    run: HarnessRun,
    decision: StateMachineRunnerDecision,
  ): Promise<HarnessTerminalTurnEvent> {
    const stateMachine = run.stateMachine;
    if (!stateMachine) {
      return this.complete(run, "failed", undefined, "No state machine is active.");
    }

    stateMachine.history.push({ type: "runner_decided", timestamp: Date.now(), decision });

    if (decision.kind === "fail") {
      return this.complete(run, "failed", undefined, decision.reason);
    }

    const selectedState = this.findState(stateMachine, decision.state);
    if (!selectedState) {
      return this.complete(run, "failed", undefined, `Unknown state: ${decision.state}`);
    }

    const effectiveState =
      decision.kind === "run_state"
        ? applyStateOverride(selectedState, decision.override)
        : selectedState;
    const nextRun = this.recordStateStarted(run, effectiveState);

    this.emit({ type: "state_machine", currentState: effectiveState.name });

    switch (effectiveState.kind) {
      case "agent":
        return this.runStateMachineAgentState(nextRun, effectiveState);
      case "script":
        return this.runStateMachineScriptState(nextRun, effectiveState);
      case "poll":
        return this.runStateMachinePollState(nextRun, effectiveState);
      case "terminal":
        return this.runStateMachineTerminalState(nextRun, effectiveState);
    }
  }

  protected async runStateMachineAgentState(
    run: HarnessRun,
    state: StateMachineAgentState,
  ): Promise<HarnessTerminalTurnEvent> {
    const childPrompt = this.createStateAgentPrompt(run, state);
    const childRun: HarnessRun = {
      ...run,
      mode: "agent",
      status: "running",
      stateMachine: undefined,
      agent: { ...run.agent, status: "running" },
    };
    const childResult = await this.runAgentMode(childRun, childPrompt, state.options);
    const parentRun = { ...run, agent: childResult.run.agent };
    const updatedRun = this.recordStateCompleted(parentRun, state.name, {
      result: childResult.type === "complete" ? childResult.result : undefined,
      childStatus: childResult.run.status,
    });

    if (childResult.type === "ask") {
      return { ...childResult, run: this.withRunStatus(updatedRun, "waiting_for_human") };
    }
    if (childResult.type === "sleep") {
      return { ...childResult, run: this.withRunStatus(updatedRun, "sleeping") };
    }
    if (childResult.type === "interrupted") {
      return { ...childResult, run: this.withRunStatus(updatedRun, "interrupted") };
    }

    return {
      ...childResult,
      run: this.withRunStatus(updatedRun, childResult.status),
    };
  }

  protected async runStateMachineScriptState(
    run: HarnessRun,
    state: StateMachineScriptState,
  ): Promise<HarnessTerminalTurnEvent> {
    try {
      const { stdout } = await execFileAsync("sh", ["-lc", state.command], {
        cwd: state.cwd ?? this.config.cwd ?? process.cwd(),
        timeout: state.timeoutMs,
      });
      const output = this.parseStructuredOutput(stdout);
      return this.complete(
        this.recordStateCompleted(run, state.name, output),
        "completed",
        stdout.trim(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.complete(
        this.recordStateFailed(run, state.name, message),
        "failed",
        undefined,
        message,
      );
    }
  }

  protected async runStateMachinePollState(
    run: HarnessRun,
    state: StateMachinePollState,
  ): Promise<HarnessTerminalTurnEvent> {
    if (state.poll.kind === "prompt") {
      const result = await this.runAgentMode(
        this.createInitialRun(state.poll.prompt, "agent"),
        state.poll.prompt,
      );
      const output =
        result.type === "complete" && result.result ? this.parseJsonObject(result.result) : {};
      if (Object.keys(output).length > 0) {
        return this.complete(
          this.recordStateCompleted(run, state.name, output),
          "completed",
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
          return this.complete(
            this.recordStateCompleted(run, state.name, output),
            "completed",
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
      run: this.withRunStatus(run, "sleeping"),
    };
  }

  protected async runStateMachineTerminalState(
    run: HarnessRun,
    state: StateMachineTerminalState,
  ): Promise<HarnessTerminalTurnEvent> {
    const terminal = { state: state.name, status: state.status, reason: state.reason };
    const stateMachine = run.stateMachine
      ? {
          ...run.stateMachine,
          terminal,
          history: [
            ...run.stateMachine.history,
            { type: "run_completed" as const, timestamp: Date.now(), terminal },
          ],
        }
      : undefined;

    return this.complete({ ...run, stateMachine }, state.status, state.reason);
  }

  private createInitialRun(prompt: string, mode: HarnessMode): HarnessRun {
    return {
      status: "running",
      mode,
      agent: {
        status: "running",
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
    };
  }

  private initializeStateMachineRun(
    run: HarnessRun,
    prompt: string,
    definition: StateMachineDefinition,
    currentState: string,
  ): HarnessRun {
    const now = Date.now();
    return {
      ...run,
      status: "running",
      stateMachine: {
        definition,
        prompt,
        currentState,
        state: {},
        history: [{ type: "run_started", timestamp: now }],
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  private createStateMachineSystemPrompt(mode: HarnessMode): string {
    const constraint =
      mode === "auto"
        ? "You may create new state-machine definitions whenever durable lifecycle work appears."
        : "You must stay constrained to the explicit state-machine definition unless no state fits.";
    return [
      this.config.systemInstructions,
      "Route durable business-process work through state-machine tools whenever possible.",
      "If the request is simple or unrelated, answer normally without calling a harness-control tool.",
      constraint,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private createStateAgentPrompt(run: HarnessRun, state: StateMachineAgentState): string {
    const stateMachine = run.stateMachine;
    if (!stateMachine) return state.prompt;

    const context =
      state.contextScope === "state_machine"
        ? {
            originalPrompt: stateMachine.prompt,
            state: stateMachine.state,
            history: stateMachine.history,
            definition: stateMachine.definition,
          }
        : {
            originalPrompt: stateMachine.prompt,
            state: stateMachine.state,
          };

    return [
      state.prompt,
      "Use this state-machine context as the source of truth for this state:",
      JSON.stringify(context, null, 2),
    ].join("\n\n");
  }

  private resolveModel(options?: HarnessTurnOptions): Model<any> {
    if (!options?.model) {
      return this.config.harnessModel;
    }
    const separator = options.model.indexOf(":");
    if (separator === -1) {
      return this.config.harnessModel;
    }
    const provider = options.model.slice(0, separator) as Parameters<typeof getModel>[0];
    const model = options.model.slice(separator + 1) as Parameters<typeof getModel>[1];
    return getModel(provider, model);
  }

  private resolveThinkingLevel(options?: HarnessTurnOptions) {
    if (!options?.thinkingLevel || options.thinkingLevel === "auto") {
      return "medium";
    }
    if (options.thinkingLevel === "none") {
      return "off";
    }
    return options.thinkingLevel === "low" ? "minimal" : options.thinkingLevel;
  }

  private emitAgentEvent(event: AgentEvent): void {
    if (event.type === "message_update" && "assistantMessageEvent" in event) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        this.emit({ type: "step", step: { type: "text", text: update.delta } });
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

  private findState(run: StateMachineRun, name: string): StateMachineState | undefined {
    return run.definition.states.find((state) => state.name === name);
  }

  private appendUserMessage(run: HarnessRun, text: string): HarnessRun {
    return {
      ...run,
      agent: {
        ...run.agent,
        messages: [
          ...run.agent.messages,
          { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        ],
      },
    };
  }

  private withRunStatus(run: HarnessRun, status: HarnessRunStatus): HarnessRun {
    return { ...run, status };
  }

  private complete(
    run: HarnessRun,
    status: HarnessTerminalStatus,
    result?: string,
    error?: string,
  ): HarnessTerminalTurnEvent {
    return {
      type: "complete",
      status,
      result,
      error,
      run: {
        ...run,
        status,
      },
    };
  }

  private recordStateStarted(run: HarnessRun, state: StateMachineState): HarnessRun {
    const stateMachine = run.stateMachine;
    if (!stateMachine) return run;
    return {
      ...run,
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

  private recordStateCompleted(run: HarnessRun, state: string, output: unknown): HarnessRun {
    const stateMachine = run.stateMachine;
    if (!stateMachine) return run;
    return {
      ...run,
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

  private recordStateFailed(run: HarnessRun, state: string, error: string): HarnessRun {
    const stateMachine = run.stateMachine;
    if (!stateMachine) return run;
    return {
      ...run,
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
