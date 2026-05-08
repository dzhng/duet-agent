import type { TurnQuestion, TurnRunnerTerminalStatus } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineSession,
  StateMachineTerminalState,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import {
  currentScheduledState,
  elapsedSinceStateStarted,
  findState,
  recordRunnerDecision,
  recordStateAskedUser,
  recordStateCompleted,
  recordStateFailed,
  recordStateInterrupted,
  recordStateMachineCompleted,
  recordStateStarted,
  recordStateSleep,
  createStateMachineSession,
} from "./state-machine-session.js";
import {
  createShellStateHandle,
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
  ShellCommandError,
  type ShellCommandOutput,
  type ShellPartialOutput,
  type ShellStateHandle,
} from "./shell-state-handle.js";
import { applyStateOverride, type StateMachineRunnerDecision } from "./tools.js";

export type StateMachineExecutionResult =
  | { type: "state_completed"; stateName: string; output?: unknown }
  | { type: "terminal"; status: TurnRunnerTerminalStatus; result?: string; error?: string }
  | { type: "ask"; questions: TurnQuestion[] }
  | { type: "sleep"; wakeAt: number }
  | { type: "interrupted" };

export type StateAgentResult =
  | { type: "complete"; result?: string }
  | { type: "ask"; questions: TurnQuestion[] }
  | { type: "failed"; error: string }
  | { type: "interrupted" };

export interface StateAgentHandle {
  /** Starts the state agent from a fresh transcript owned by the host. */
  prompt(): Promise<StateAgentResult>;
  /** Aborts the in-process state agent; persisted state-agent messages are discarded. */
  interrupt(): void;
  /** Text-only partial output used for interruption history without persisting messages. */
  partialAssistantText(): string | undefined;
}

export type ActiveStateOutput =
  | { state?: string; kind: "agent"; output?: { assistantText?: string } }
  | { state: string; kind: "script" | "poll"; output?: ShellPartialOutput };

type ActiveStateRun =
  | {
      kind: "agent";
      state: string | undefined;
      agent: StateAgentHandle;
      interruptedReason?: string;
    }
  | {
      kind: "script";
      state: string;
      shell: ShellStateHandle;
      interruptedReason?: string;
    }
  | {
      kind: "poll";
      state: StateMachinePollState;
      shell: ShellStateHandle;
      interruptedReason?: string;
    };

export interface StateMachineControllerConfig {
  /** Default working directory used by script and poll-script states. */
  cwd: string;
  /** Builds a fresh transient state-agent handle for one agent state execution. */
  createStateAgent(input: { state: StateMachineAgentState; prompt: string }): StateAgentHandle;
}

export class StateMachineController {
  private session?: StateMachineSession;
  private activeRun?: ActiveStateRun;

  constructor(private readonly config: StateMachineControllerConfig) {}

  hydrate(stateMachine: StateMachineSession | undefined): void {
    this.session = stateMachine;
  }

  getSession(): StateMachineSession | undefined {
    return this.session;
  }

  hasActiveWork(): boolean {
    return Boolean(this.activeRun);
  }

  getActiveOutput(): ActiveStateOutput | undefined {
    const run = this.activeRun;
    if (!run) return undefined;
    if (run.kind === "agent") {
      const assistantText = run.agent.partialAssistantText();
      return assistantText
        ? { state: run.state, kind: "agent", output: { assistantText } }
        : { state: run.state, kind: "agent" };
    }
    if (run.kind === "script") {
      const output = run.shell.partialOutput();
      return output
        ? { state: run.state, kind: "script", output }
        : { state: run.state, kind: "script" };
    }
    const output = run.shell.partialOutput();
    return output
      ? { state: run.state.name, kind: "poll", output }
      : { state: run.state.name, kind: "poll" };
  }

  startSession(input: {
    prompt: string;
    definition: StateMachineDefinition;
    currentState: string;
  }): void {
    this.session = createStateMachineSession(input.prompt, input.definition, input.currentState);
  }

  interrupt(reason = "Interrupted"): void {
    const run = this.activeRun;
    if (!run) return;
    run.interruptedReason = reason;
    const state = this.interruptibleStateName(run);
    if (this.session && state) {
      this.session = recordStateInterrupted(
        this.session,
        state,
        reason,
        this.interruptedOutput(run),
      );
    }
    if (run.kind === "agent") {
      run.agent.interrupt();
    } else {
      run.shell.interrupt();
    }
  }

  async runDecision(decision: StateMachineRunnerDecision): Promise<StateMachineExecutionResult> {
    if (this.hasActiveWork()) {
      // Selecting a state while work is active is an intentional replacement.
      // The parent can steer state-machine progress by selecting the same state
      // with new input or by selecting a different state; transient work is
      // aborted before the new state starts.
      this.interrupt("Replaced by a newly selected state.");
    }
    const stateMachine = this.requireSession();
    this.session = recordRunnerDecision(stateMachine, decision);

    if (decision.kind === "fail") {
      const state = this.session.currentState ?? "unknown";
      this.session = recordStateFailed(this.session, state, decision.reason);
      return { type: "terminal", status: "failed", error: decision.reason };
    }

    const selectedState = findState(this.session, decision.state);
    if (!selectedState) {
      const validStates = this.session.definition.states.map((state) => state.name);
      const message = `Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`;
      this.session = recordStateFailed(
        this.session,
        this.session.currentState ?? decision.state,
        message,
      );
      return { type: "terminal", status: "failed", error: message };
    }

    const effectiveState =
      decision.kind === "run_state"
        ? applyStateOverride(selectedState, decision.override)
        : selectedState;
    this.session = recordStateStarted(
      this.session,
      effectiveState,
      decision.kind === "run_state" ? decision.input : undefined,
    );
    switch (effectiveState.kind) {
      case "agent":
        return this.runAgentState(effectiveState);
      case "script":
        return this.runScriptState(effectiveState);
      case "poll":
        return this.runPollState(effectiveState);
      case "timer":
        return this.runTimerState(effectiveState);
      case "terminal":
        return this.runTerminalState(effectiveState);
    }
  }

  async wake(): Promise<StateMachineExecutionResult | undefined> {
    const state = currentScheduledState(this.session);
    if (!state) return undefined;
    return state.kind === "poll" ? this.runPollState(state) : this.runTimerState(state, true);
  }

  private async runAgentState(state: StateMachineAgentState): Promise<StateMachineExecutionResult> {
    const prompt = renderTemplate(state.prompt, this.session?.currentInput ?? {});
    const agent = this.config.createStateAgent({ state, prompt });
    const run: ActiveStateRun = { kind: "agent", state: state.name, agent };
    this.activeRun = run;
    try {
      const terminal = await agent.prompt();
      if (terminal.type === "ask") {
        this.session = recordStateAskedUser(this.requireSession(), state.name, terminal.questions);
        return { type: "ask", questions: terminal.questions };
      }
      if (terminal.type === "failed") {
        this.session = recordStateFailed(this.requireSession(), state.name, terminal.error);
        return { type: "terminal", status: "failed", error: terminal.error };
      }
      if (terminal.type === "interrupted") {
        if (this.activeRun === run) this.recordInterruptedState(run, state.name);
        return { type: "interrupted" };
      }

      const output = { result: terminal.result };
      this.session = recordStateCompleted(this.requireSession(), state.name, output);
      return { type: "state_completed", stateName: state.name, output };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  private async runScriptState(
    state: StateMachineScriptState,
  ): Promise<StateMachineExecutionResult> {
    const command = renderTemplate(state.command, this.session?.currentInput ?? {});
    const shell = createShellStateHandle({
      command,
      cwd: state.cwd ?? this.config.cwd,
      timeoutMs: state.timeoutMs,
      successCodes: state.successCodes,
    });
    const run: ActiveStateRun = { kind: "script", state: state.name, shell };
    this.activeRun = run;
    try {
      const shellOutput = await shell.run();
      const rawOutput = normalizeStructuredShellOutput(shellOutput);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (run.interruptedReason) {
        if (this.activeRun === run)
          this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "failed", error: message };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  private async runPollState(state: StateMachinePollState): Promise<StateMachineExecutionResult> {
    const elapsedMs = elapsedSinceStateStarted(this.session, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "failed", error: message };
    }

    const command = renderTemplate(state.command, this.session?.currentInput ?? {});
    const shell = createShellStateHandle({
      command,
      cwd: state.cwd ?? this.config.cwd,
      successCodes: state.successCodes,
    });
    const run: ActiveStateRun = { kind: "poll", state, shell };
    this.activeRun = run;
    try {
      const shellOutput = await shell.run();
      const output = parseJsonObject(shellOutput.stdout);
      if (Object.keys(output).length === 0) {
        const wakeAt = Date.now() + state.intervalMs;
        this.session = recordStateSleep(this.requireSession(), state, wakeAt);
        return { type: "sleep", wakeAt };
      }
      const rawOutput = normalizePollShellOutput(shellOutput, output);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (run.interruptedReason) {
        if (this.activeRun === run)
          this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      const wakeAt = Date.now() + state.intervalMs;
      this.session = recordStateSleep(this.requireSession(), state, wakeAt);
      return { type: "sleep", wakeAt };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
    }
  }

  private runTimerState(state: StateMachineTimerState, woke = false): StateMachineExecutionResult {
    if (!woke && state.wakeAt > Date.now()) {
      this.session = recordStateSleep(this.requireSession(), state, state.wakeAt);
      return { type: "sleep", wakeAt: state.wakeAt };
    }

    const output = {
      elapsedMs: elapsedSinceStateStarted(this.session, state.name),
      timestamp: Date.now(),
    };
    this.session = recordStateCompleted(this.requireSession(), state.name, output);
    return { type: "state_completed", stateName: state.name, output };
  }

  private async runTerminalState(
    state: StateMachineTerminalState,
  ): Promise<StateMachineExecutionResult> {
    const terminal = { state: state.name, status: state.status, reason: state.reason };
    this.session = recordStateMachineCompleted(this.requireSession(), terminal);
    return { type: "terminal", status: state.status, result: state.reason };
  }

  private recordInterruptedState(
    run: ActiveStateRun,
    stateName: string,
    output?: { assistantText?: string } | ShellPartialOutput,
  ): void {
    const session = this.requireSession();
    const last = session.history.at(-1);
    if (
      session.currentState === INTERRUPTED_STATE_MACHINE_STATE &&
      last?.type === "state_interrupted" &&
      last.state === stateName
    ) {
      this.session = {
        ...session,
        history: [
          ...session.history.slice(0, -1),
          {
            ...last,
            reason: run.interruptedReason ?? last.reason,
            output: output ?? last.output,
          },
        ],
        updatedAt: Date.now(),
      };
      return;
    }
    this.session = recordStateInterrupted(
      session,
      stateName,
      run.interruptedReason ?? "Interrupted",
      output,
    );
  }

  private interruptedOutput(
    run: ActiveStateRun,
  ): { assistantText?: string } | ShellPartialOutput | undefined {
    if (run.kind === "agent") {
      const assistantText = run.agent.partialAssistantText();
      return assistantText ? { assistantText } : undefined;
    }
    return run.shell.partialOutput();
  }

  private interruptibleStateName(run: ActiveStateRun): string | undefined {
    if (run.kind === "agent") return run.state;
    if (run.kind === "script") return run.state;
    return run.state.name;
  }

  private requireSession(): StateMachineSession {
    if (!this.session) {
      throw new Error("No state machine is active.");
    }
    return this.session;
  }
}

function normalizeStructuredShellOutput(shellOutput: ShellCommandOutput): ShellCommandOutput & {
  parsed: Record<string, unknown>;
} {
  return {
    ...shellOutput,
    stdout: shellOutput.stdout.trim(),
    stderr: shellOutput.stderr.trim(),
    parsed: parseStructuredOutput(shellOutput.stdout),
  };
}

function normalizePollShellOutput(
  shellOutput: ShellCommandOutput,
  parsed: Record<string, unknown>,
): ShellCommandOutput & { parsed: Record<string, unknown> } {
  return {
    ...shellOutput,
    stdout: shellOutput.stdout.trim(),
    stderr: shellOutput.stderr.trim(),
    parsed,
  };
}

function shellPartialOutput(error: unknown): { stdout: string; stderr: string } | undefined {
  if (!(error instanceof ShellCommandError)) return undefined;
  return { stdout: error.output.stdout, stderr: error.output.stderr };
}
