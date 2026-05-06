import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { toXML } from "../lib/xml.js";
import type {
  TurnAnswerCommand,
  TurnEvent,
  TurnMode,
  TurnPromptCommand,
  TurnRunnerTerminalStatus,
  TurnState,
  TurnTerminalEvent,
} from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineSession,
  StateMachineState,
  StateMachineTerminalState,
} from "../types/state-machine.js";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
  runShellCommand,
  type ShellCommandOutput,
} from "./shell-exec.js";
import { createStateMachineSystemPromptLayer } from "./prompts.js";
import {
  applyStateOverride,
  type StateMachineRunnerDecision,
  type TurnRunnerControlResult,
} from "./tools.js";
import type { AgentWorkerInput, AgentWorkerResult } from "./agent-worker.js";

export type ActiveStateWork =
  | { kind: "script" }
  | {
      kind: "poll";
      session: TurnState;
      state: StateMachinePollState;
      promptStarted: Promise<void>;
      resolvePromptStarted: () => void;
      promptTerminal?: Promise<TurnTerminalEvent>;
    };

interface StateMachineRuntimeDeps {
  cwd(): string;
  emit(event: TurnEvent): void;
  complete(
    session: TurnState,
    status: TurnRunnerTerminalStatus,
    result?: string,
    error?: string,
  ): TurnTerminalEvent;
  askUserQuestion(
    terminal: TurnTerminalEvent,
    control: Extract<TurnRunnerControlResult, { type: "ask_user_question" }>,
  ): TurnTerminalEvent;
  createTools(mode: TurnMode, session?: TurnState): { tools: AgentTool[] };
  runAgentWorkerWithUsage(
    input: AgentWorkerInput,
    activeSlot?: "parent" | "state_machine_child",
  ): Promise<AgentWorkerResult>;
  resolveStateAgentSkills(state: StateMachineAgentState): Skill[] | undefined;
  prompt(command: TurnPromptCommand): Promise<TurnTerminalEvent>;
  drainQueuedTurnCommands(terminal: TurnTerminalEvent): Promise<TurnTerminalEvent>;
  hasQueuedTurnCommands(): boolean;
  isDrainingQueuedCommandsBeforeContinuation(): boolean;
  setDrainingQueuedCommandsBeforeContinuation(value: boolean): void;
  setCurrentState(state: TurnState): void;
  consumeInterruptedTerminal(): TurnTerminalEvent | undefined;
  setActiveAbortController(controller: AbortController | undefined): void;
  setActiveStateWork(work: ActiveStateWork | undefined): void;
}

export class StateMachineRuntime {
  constructor(private readonly deps: StateMachineRuntimeDeps) {}

  async run(session: TurnState, decision: StateMachineRunnerDecision): Promise<TurnTerminalEvent> {
    session = this.recordRunnerDecision(session, decision);
    const stateMachine = session.stateMachine;
    if (!stateMachine) {
      return this.deps.complete(session, "failed", undefined, "No state machine is active.");
    }

    if (decision.kind === "fail") {
      return this.deps.complete(session, "failed", undefined, decision.reason);
    }

    const selectedState = this.findState(stateMachine, decision.state);
    if (!selectedState) {
      const validStates = stateMachine.definition.states.map((state) => state.name);
      return this.deps.complete(
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

    this.deps.emit({ type: "state_machine", currentState: effectiveState.name });

    switch (effectiveState.kind) {
      case "agent":
        return this.runAgentState(nextSession, effectiveState);
      case "script":
        return this.runScriptState(nextSession, effectiveState);
      case "poll":
        return this.runPollState(nextSession, effectiveState);
      case "terminal":
        return this.runTerminalState(nextSession, effectiveState);
    }
  }

  async runAgentState(
    session: TurnState,
    state: StateMachineAgentState,
  ): Promise<TurnTerminalEvent> {
    const childPrompt = renderTemplate(state.prompt, session.stateMachine?.currentInput ?? {});
    return this.runAgentStatePrompt(session, state, childPrompt);
  }

  async promptAgent(session: TurnState, prompt: string): Promise<TurnTerminalEvent> {
    const stateMachine = session.stateMachine;
    const currentState = stateMachine?.currentState
      ? this.findState(stateMachine, stateMachine.currentState)
      : undefined;
    if (!stateMachine || currentState?.kind !== "agent") {
      return this.deps.complete(
        session,
        "failed",
        undefined,
        "Cannot prompt state-machine agent because the current state is not an agent state.",
      );
    }
    return this.runAgentStatePrompt(session, currentState, prompt);
  }

  async runAgentStatePrompt(
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
    const childWorkerResult = await this.deps.runAgentWorkerWithUsage(
      {
        state: childState,
        prompt,
        appendSystemPrompt: state.systemPrompt,
        skills: this.deps.resolveStateAgentSkills(state),
        ...this.deps.createTools("agent"),
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

    return this.continueAfterStateCompleted(
      { ...updatedSession, status: "running" },
      state.name,
      rawOutput,
    );
  }

  async runScriptState(
    session: TurnState,
    state: StateMachineScriptState,
  ): Promise<TurnTerminalEvent> {
    const abortController = new AbortController();
    this.deps.setActiveAbortController(abortController);
    this.deps.setActiveStateWork({ kind: "script" });
    try {
      const command = renderTemplate(state.command, session.stateMachine?.currentInput ?? {});
      const shellOutput = await runShellCommand(command, {
        cwd: state.cwd ?? this.deps.cwd(),
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
        this.recordStateCompleted(session, state.name, rawOutput),
        state.name,
        rawOutput,
      );
    } catch (error) {
      const interrupted = this.deps.consumeInterruptedTerminal();
      if (interrupted) return interrupted;
      const message = error instanceof Error ? error.message : String(error);
      return this.deps.complete(
        this.recordStateFailed(session, state.name, message),
        "failed",
        undefined,
        message,
      );
    } finally {
      this.deps.setActiveAbortController(undefined);
      this.deps.setActiveStateWork(undefined);
    }
  }

  async runPollState(
    session: TurnState,
    state: StateMachinePollState,
    options?: { woke?: boolean },
  ): Promise<TurnTerminalEvent> {
    const elapsedMs = this.elapsedSinceStateStarted(session, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      return this.deps.complete(
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
      return this.continueAfterStateCompleted(
        this.recordStateCompleted(session, state.name, output),
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
      session,
      state,
      promptStarted,
      resolvePromptStarted,
    };
    this.deps.setActiveAbortController(abortController);
    this.deps.setActiveStateWork(work);
    try {
      const command = renderTemplate(state.poll.command, session.stateMachine?.currentInput ?? {});
      let settledShell:
        | { status: "fulfilled"; value: ShellCommandOutput }
        | { status: "rejected"; reason: unknown }
        | undefined;
      const shellPromise = runShellCommand(command, {
        cwd: state.poll.cwd ?? this.deps.cwd(),
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
      const interrupted = this.deps.consumeInterruptedTerminal();
      if (interrupted) return interrupted;
      // A poll with no result sleeps; failures can be modeled by the script output.
    } finally {
      this.deps.setActiveAbortController(undefined);
      this.deps.setActiveStateWork(undefined);
    }

    return this.sleep(session, state);
  }

  runPromptDuringActivePoll(
    work: Extract<ActiveStateWork, { kind: "poll" }>,
    command: TurnPromptCommand | TurnAnswerCommand,
    prompt: string,
  ): void {
    if (work.promptTerminal) return;
    this.deps.setCurrentState({ ...work.session, status: "running" });
    work.promptTerminal = this.deps
      .prompt({
        type: "prompt",
        message: prompt,
        behavior: command.behavior,
        options: command.options,
      })
      .then((terminal) => this.restorePollSleepAfterMidPollPrompt(work, terminal));
    work.resolvePromptStarted();
  }

  restorePollSleepAfterMidPollPrompt(
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

  restoreSleepAfterPromptIfNeeded(
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
      this.deps.emit({
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

  async runTerminalState(
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

    return this.deps.complete({ ...session, stateMachine }, state.status, state.reason);
  }

  async continueAfterStateCompleted(
    session: TurnState,
    state: string,
    output?: unknown,
  ): Promise<TurnTerminalEvent> {
    if (session.mode === "agent") {
      return this.deps.complete(
        session,
        "completed",
        typeof output === "string" ? output : undefined,
      );
    }

    if (
      !this.deps.isDrainingQueuedCommandsBeforeContinuation() &&
      this.deps.hasQueuedTurnCommands()
    ) {
      this.deps.setDrainingQueuedCommandsBeforeContinuation(true);
      try {
        const terminal = await this.deps.drainQueuedTurnCommands({
          type: "complete",
          status: "completed",
          state: session,
        });
        if (terminal.type !== "complete" || terminal.status !== "completed") {
          return terminal;
        }
        session = terminal.state;
      } finally {
        this.deps.setDrainingQueuedCommandsBeforeContinuation(false);
      }
    }

    let nextSession = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryInstruction =
        attempt === 1
          ? ""
          : `This is retry ${attempt} of 3. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;

      const workerResult = await this.deps.runAgentWorkerWithUsage({
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
        ...this.deps.createTools(session.mode, session),
      });

      nextSession = workerResult.terminal.state;
      if (workerResult.control.type === "ask_user_question") {
        return this.deps.askUserQuestion(workerResult.terminal, workerResult.control);
      }

      if (workerResult.control.type === "select_state_machine_state") {
        return this.run(nextSession, workerResult.control.decision);
      }

      if (workerResult.control.type === "create_state_machine_definition") {
        return this.deps.complete(
          nextSession,
          "failed",
          undefined,
          "Cannot create a new state-machine definition while the current state machine is still active.",
        );
      }
    }

    return this.deps.complete(
      nextSession,
      "failed",
      undefined,
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  createInitialState(mode: TurnMode): TurnState {
    return {
      status: "running",
      mode,
      agent: {
        status: "running",
        messages: [],
      },
    };
  }

  initializeState(
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

  findState(session: StateMachineSession, name: string): StateMachineState | undefined {
    return session.definition.states.find((state) => state.name === name);
  }

  currentPollState(state: TurnState | undefined): StateMachinePollState | undefined {
    const stateMachine = state?.stateMachine;
    const currentState = stateMachine?.currentState;
    if (!stateMachine || !currentState) return undefined;
    const definitionState = this.findState(stateMachine, currentState);
    return definitionState?.kind === "poll" ? definitionState : undefined;
  }

  isWaitingOnPoll(state: TurnState | undefined): boolean {
    return Boolean(this.currentPollState(state) && !state?.stateMachine?.terminal);
  }

  appendUserMessage(session: TurnState, text: string): TurnState {
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

  private recordRunnerDecision(
    session: TurnState,
    decision: StateMachineRunnerDecision,
  ): TurnState {
    const stateMachine = session.stateMachine;
    if (!stateMachine) return session;
    return {
      ...session,
      stateMachine: {
        ...stateMachine,
        history: [
          ...stateMachine.history,
          { type: "runner_decided", timestamp: Date.now(), decision },
        ],
        updatedAt: Date.now(),
      },
    };
  }

  recordStateStarted(
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

  recordStateCompleted(session: TurnState, state: string, output: unknown): TurnState {
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

  elapsedSinceStateStarted(session: TurnState, state: string): number {
    const history = session.stateMachine?.history ?? [];
    for (let index = history.length - 1; index >= 0; index--) {
      const event = history[index];
      if (event.type === "state_started" && event.state === state) {
        return Math.max(0, Date.now() - event.timestamp);
      }
    }
    return 0;
  }

  recordStateFailed(session: TurnState, state: string, error: string): TurnState {
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

  recordStateInterrupted(session: TurnState, reason?: string): TurnState {
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

  sleep(session: TurnState, state: StateMachinePollState): TurnTerminalEvent {
    return {
      type: "sleep",
      wakeAt: Date.now() + state.intervalMs,
      state: { ...session, status: "sleeping" },
    };
  }

  private completePollStateAfterShellResult(
    session: TurnState,
    state: StateMachinePollState,
    shellOutput: ShellCommandOutput,
  ): Promise<TurnTerminalEvent> | TurnTerminalEvent {
    const { stdout } = shellOutput;
    const output = parseJsonObject(stdout);
    if (Object.keys(output).length === 0) {
      return this.sleep(session, state);
    }

    const rawOutput = {
      ...shellOutput,
      stdout: stdout.trim(),
      stderr: shellOutput.stderr.trim(),
      parsed: output,
    };
    return this.continueAfterStateCompleted(
      this.recordStateCompleted(session, state.name, rawOutput),
      state.name,
      rawOutput,
    );
  }
}
