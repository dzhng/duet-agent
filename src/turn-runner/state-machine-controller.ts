import type { TurnQuestion, TurnRunnerTerminalStatus } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineSession,
  StateMachineTerminalState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import {
  currentPollState,
  elapsedSinceStateStarted,
  findState,
  recordRunnerDecision,
  recordStateAskedUser,
  recordStateCompleted,
  recordStateFailed,
  recordStateInterrupted,
  recordStateMachineCompleted,
  recordStateStarted,
  createStateMachineSession,
} from "./state-machine-session.js";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
  runShellCommand,
  ShellCommandError,
  type ShellCommandOutput,
} from "./shell-exec.js";
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

type ActiveStateWork =
  | { kind: "script"; state: string }
  | {
      kind: "poll";
      state: StateMachinePollState;
    };

export interface StateMachineControllerConfig {
  /** Default working directory used by script and poll-script states. */
  cwd: string;
  /** Builds a fresh transient state-agent handle for one agent state execution. */
  createStateAgent(input: { state: StateMachineAgentState; prompt: string }): StateAgentHandle;
}

export class StateMachineController {
  private session?: StateMachineSession;
  private activeAbortController?: AbortController;
  private activeStateWork?: ActiveStateWork;
  private activeStateAgent?: StateAgentHandle;
  private interruptedReason?: string;

  constructor(private readonly config: StateMachineControllerConfig) {}

  hydrate(stateMachine: StateMachineSession | undefined): void {
    this.session = stateMachine;
  }

  getSession(): StateMachineSession | undefined {
    return this.session;
  }

  hasActiveWork(): boolean {
    return Boolean(this.activeAbortController || this.activeStateWork || this.activeStateAgent);
  }

  hasActiveStateAgent(): boolean {
    return Boolean(this.activeStateAgent);
  }

  startSession(input: {
    prompt: string;
    definition: StateMachineDefinition;
    currentState: string;
  }): void {
    this.session = createStateMachineSession(input.prompt, input.definition, input.currentState);
  }

  interrupt(reason = "Interrupted"): void {
    this.interruptedReason = reason;
    const state = this.interruptibleStateName();
    if (this.session && state) {
      this.session = recordStateInterrupted(this.session, state, reason, this.interruptedOutput());
    }
    this.activeStateAgent?.interrupt();
    this.activeAbortController?.abort();
    this.activeStateAgent = undefined;
    this.activeStateWork = undefined;
    this.activeAbortController = undefined;
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
      case "terminal":
        return this.runTerminalState(effectiveState);
    }
  }

  async wake(): Promise<StateMachineExecutionResult | undefined> {
    const state = currentPollState(this.session);
    if (!state) return undefined;
    return this.runPollState(state, { woke: true });
  }

  private async runAgentState(state: StateMachineAgentState): Promise<StateMachineExecutionResult> {
    const prompt = renderTemplate(state.prompt, this.session?.currentInput ?? {});
    const agent = this.config.createStateAgent({ state, prompt });
    this.activeStateAgent = agent;
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
        this.recordInterruptedState(state.name);
        return { type: "interrupted" };
      }

      const output = { result: terminal.result };
      this.session = recordStateCompleted(this.requireSession(), state.name, output);
      return { type: "state_completed", stateName: state.name, output };
    } finally {
      this.activeStateAgent = undefined;
    }
  }

  private async runScriptState(
    state: StateMachineScriptState,
  ): Promise<StateMachineExecutionResult> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeStateWork = { kind: "script", state: state.name };
    try {
      const command = renderTemplate(state.command, this.session?.currentInput ?? {});
      const shellOutput = await runShellCommand(command, {
        cwd: state.cwd ?? this.config.cwd,
        timeoutMs: state.timeoutMs,
        signal: abortController.signal,
        successCodes: state.successCodes,
      });
      const rawOutput = normalizeStructuredShellOutput(shellOutput);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (this.interruptedReason) {
        this.recordInterruptedState(state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "failed", error: message };
    } finally {
      this.activeAbortController = undefined;
      this.activeStateWork = undefined;
      this.interruptedReason = undefined;
    }
  }

  private async runPollState(
    state: StateMachinePollState,
    options?: { woke?: boolean },
  ): Promise<StateMachineExecutionResult> {
    const elapsedMs = elapsedSinceStateStarted(this.session, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "failed", error: message };
    }

    if (state.poll.kind === "timer") {
      if (!options?.woke) {
        return { type: "sleep", wakeAt: Date.now() + state.intervalMs };
      }
      const output = { elapsedMs };
      this.session = recordStateCompleted(this.requireSession(), state.name, output);
      return { type: "state_completed", stateName: state.name, output };
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeStateWork = { kind: "poll", state };
    try {
      const command = renderTemplate(state.poll.command, this.session?.currentInput ?? {});
      const shellOutput = await runShellCommand(command, {
        cwd: state.poll.cwd ?? this.config.cwd,
        signal: abortController.signal,
        successCodes: state.poll.successCodes,
      });
      const output = parseJsonObject(shellOutput.stdout);
      if (Object.keys(output).length === 0) {
        return { type: "sleep", wakeAt: Date.now() + state.intervalMs };
      }
      const rawOutput = normalizePollShellOutput(shellOutput, output);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (this.interruptedReason) {
        this.recordInterruptedState(state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      return { type: "sleep", wakeAt: Date.now() + state.intervalMs };
    } finally {
      this.activeAbortController = undefined;
      this.activeStateWork = undefined;
      this.interruptedReason = undefined;
    }
  }

  private async runTerminalState(
    state: StateMachineTerminalState,
  ): Promise<StateMachineExecutionResult> {
    const terminal = { state: state.name, status: state.status, reason: state.reason };
    this.session = recordStateMachineCompleted(this.requireSession(), terminal);
    return { type: "terminal", status: state.status, result: state.reason };
  }

  private recordInterruptedState(
    stateName: string,
    output?: { assistantText?: string } | { stdout: string; stderr: string },
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
            reason: this.interruptedReason ?? last.reason,
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
      this.interruptedReason ?? "Interrupted",
      output,
    );
  }

  private interruptedOutput():
    | { assistantText?: string }
    | { stdout: string; stderr: string }
    | undefined {
    if (this.activeStateAgent) {
      const assistantText = this.activeStateAgent.partialAssistantText();
      return assistantText ? { assistantText } : undefined;
    }
    return undefined;
  }

  private interruptibleStateName(): string | undefined {
    if (this.activeStateAgent) return this.session?.currentState;
    if (this.activeStateWork?.kind === "script") return this.activeStateWork.state;
    if (this.activeStateWork?.kind === "poll") return this.activeStateWork.state.name;
    return undefined;
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
