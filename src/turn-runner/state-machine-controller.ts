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
  /**
   * Abort the state agent and remember why. The handle is responsible for
   * making `prompt()` settle as `{ type: "interrupted" }` after this is
   * called — callers do not classify the abort themselves.
   */
  interrupt(reason: string): void;
  /** Text-only partial output used for interruption history without persisting messages. */
  partialAssistantText(): string | undefined;
  /** The reason passed to `interrupt()`, or undefined if not interrupted. */
  interruptedReason(): string | undefined;
}

export type ActiveStateOutput =
  | { state?: string; kind: "agent"; output?: { assistantText?: string } }
  | { state: string; kind: "script" | "poll"; output?: ShellPartialOutput };

type ActiveStateRunCommon = {
  /**
   * Resolves when the in-flight `run*State` call has fully unwound —
   * including any post-`interrupt()` cleanup the underlying handle performs.
   * `runDecision` awaits this before constructing a replacement state so
   * the previous sub-agent (or shell) cannot keep emitting events into the
   * same turn after the new state has started.
   */
  finished: Promise<void>;
};

type ActiveStateRun =
  | (ActiveStateRunCommon & {
      kind: "agent";
      state: string | undefined;
      agent: StateAgentHandle;
    })
  | (ActiveStateRunCommon & {
      kind: "script";
      state: string;
      shell: ShellStateHandle;
    })
  | (ActiveStateRunCommon & {
      kind: "poll";
      state: StateMachinePollState;
      shell: ShellStateHandle;
    });

export interface StateMachineControllerConfig {
  /** Default working directory used by script and poll-script states. */
  cwd: string;
  /** Builds a fresh transient state-agent handle for one agent state execution. */
  createStateAgent(input: { state: StateMachineAgentState; prompt: string }): StateAgentHandle;
  /**
   * Notified whenever the controller has updated `session` and the new
   * snapshot is worth broadcasting (state started, terminal reached).
   * The turn runner uses this to emit `state_machine` protocol events
   * carrying the full session, so UIs see fresh progress and current
   * state before the new state begins executing.
   */
  onSessionChanged?(session: StateMachineSession): void;
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

  /**
   * Mark the current terminal as having been surfaced to the parent
   * runner. The turn runner sets this flag before kicking off the
   * inline acknowledgment turn so the same `session.terminal` cannot
   * be acknowledged twice — if the parent (mis)routes back into the
   * controller during the acknowledgment turn and the controller
   * re-records a terminal on this same session, the second drive will
   * find the flag set and skip.
   *
   * Note that this flag is per-session: a new state machine created
   * during the acknowledgment turn lives on a brand-new session built
   * by `createStateMachineSession`, so it gets its own acknowledgment
   * when it terminates.
   */
  markTerminalAcknowledged(): void {
    if (!this.session?.terminal || this.session.terminalAcknowledged) return;
    this.session = {
      ...this.session,
      terminalAcknowledged: true,
      updatedAt: Date.now(),
    };
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
    const state = this.interruptibleStateName(run);
    if (this.session && state) {
      this.session = recordStateInterrupted(
        this.session,
        state,
        reason,
        this.interruptedOutput(run),
      );
    }
    // The handle owns interrupt classification: `interrupt(reason)` causes
    // its `prompt()` / `run()` to settle as interrupted with this reason.
    if (run.kind === "agent") {
      run.agent.interrupt(reason);
    } else {
      run.shell.interrupt(reason);
    }
  }

  async runDecision(decision: StateMachineRunnerDecision): Promise<StateMachineExecutionResult> {
    const previous = this.activeRun;
    if (previous) {
      // Selecting a state while work is active is an intentional replacement.
      // The parent can steer state-machine progress by selecting the same state
      // with new input or by selecting a different state; transient work is
      // aborted before the new state starts.
      this.interrupt("Replaced by a newly selected state.");
      // Wait for the old run to actually finish tearing down before we
      // construct the replacement. Without this, the orphaned sub-agent (or
      // shell) keeps running concurrently with the new one and its events
      // leak into the same turn after the parent already declared replacement.
      await previous.finished;
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
    this.config.onSessionChanged?.(this.session);
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
    const finished = createDeferredVoid();
    const run: ActiveStateRun = {
      kind: "agent",
      state: state.name,
      agent,
      finished: finished.promise,
    };
    this.activeRun = run;
    try {
      const terminal = await agent.prompt();
      if (terminal.type === "interrupted") {
        this.recordInterruptedState(run, state.name);
        return { type: "interrupted" };
      }
      if (terminal.type === "ask") {
        this.session = recordStateAskedUser(this.requireSession(), state.name, terminal.questions);
        return { type: "ask", questions: terminal.questions };
      }
      if (terminal.type === "failed") {
        this.session = recordStateFailed(this.requireSession(), state.name, terminal.error);
        return { type: "terminal", status: "failed", error: terminal.error };
      }

      const output = { result: terminal.result };
      this.session = recordStateCompleted(this.requireSession(), state.name, output);
      return { type: "state_completed", stateName: state.name, output };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
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
    const finished = createDeferredVoid();
    const run: ActiveStateRun = {
      kind: "script",
      state: state.name,
      shell,
      finished: finished.promise,
    };
    this.activeRun = run;
    try {
      const shellOutput = await shell.run();
      const rawOutput = normalizeStructuredShellOutput(shellOutput);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (shell.interruptedReason() !== undefined) {
        this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "failed", error: message };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
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
    const finished = createDeferredVoid();
    const run: ActiveStateRun = { kind: "poll", state, shell, finished: finished.promise };
    this.activeRun = run;
    try {
      // Poll success is determined purely by the script's exit code being
      // in `successCodes` (default [0]). `shell.run()` resolves when the
      // exit code is in the success set and rejects otherwise, so reaching
      // this branch means "this poll attempt found a result." Stdout is
      // parsed as JSON when possible for convenience, but the result of
      // that parse does NOT affect whether the poll completes.
      const shellOutput = await shell.run();
      const rawOutput = normalizePollShellOutput(shellOutput);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (shell.interruptedReason() !== undefined) {
        this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      // Exit code not in `successCodes` (or shell error) → keep polling.
      const wakeAt = Date.now() + state.intervalMs;
      this.session = recordStateSleep(this.requireSession(), state, wakeAt);
      return { type: "sleep", wakeAt };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
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
    const reason = runInterruptedReason(run);
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
            reason: reason ?? last.reason,
            output: output ?? last.output,
          },
        ],
        updatedAt: Date.now(),
      };
      return;
    }
    this.session = recordStateInterrupted(session, stateName, reason ?? "Interrupted", output);
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
): ShellCommandOutput & { parsed: Record<string, unknown> } {
  return {
    ...shellOutput,
    stdout: shellOutput.stdout.trim(),
    stderr: shellOutput.stderr.trim(),
    parsed: parseJsonObject(shellOutput.stdout),
  };
}

function shellPartialOutput(error: unknown): { stdout: string; stderr: string } | undefined {
  if (!(error instanceof ShellCommandError)) return undefined;
  return { stdout: error.output.stdout, stderr: error.output.stderr };
}

function runInterruptedReason(run: ActiveStateRun): string | undefined {
  return run.kind === "agent" ? run.agent.interruptedReason() : run.shell.interruptedReason();
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
