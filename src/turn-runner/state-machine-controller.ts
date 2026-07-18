import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnQuestion } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineSession,
  StateMachineTerminalResult,
  StateMachineTerminalState,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import { parseDurationToMs, parseWakeAtToMs } from "./duration.js";
import {
  consecutivePollGateSuccesses,
  currentScheduledState,
  elapsedSinceStateStarted,
  findState,
  MISCONFIGURED_POLL_GATE_THRESHOLD,
  recordRunnerDecision,
  recordStateAskedUser,
  recordStateCompleted,
  recordStateFailed,
  recordStateInterrupted,
  recordStateMachineCompleted,
  recordStateMachineReactivated,
  recordStateStarted,
  recordStateSleep,
  createStateMachineSession,
  persistStateDefinition,
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
import { applyStateOverride, resolveStateCwd, type StateMachineRunnerDecision } from "./tools.js";
import type { SubagentRun } from "./subagent.js";

export type StateMachineExecutionResult =
  | { type: "state_completed"; stateName: string; output?: unknown }
  | {
      type: "terminal";
      status: StateMachineTerminalResult["status"];
      result?: string;
      error?: string;
    }
  | { type: "ask"; questions: TurnQuestion[] }
  | { type: "sleep"; wakeAt: number }
  | { type: "interrupted" };

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
      agent: SubagentRun;
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
  /** Builds a fresh transient sub-agent run for one agent state execution. */
  createStateAgent(input: { state: StateMachineAgentState; prompt: string }): SubagentRun;
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

  /**
   * Records a runtime failure on the active session and returns the matching
   * `error` terminal. Used by the turn runner when a protocol violation cannot
   * be recovered (e.g. the parent exhausted its re-prompt budget without
   * calling select_state_machine_state). Recording it here — rather than
   * returning a terminal the runner never persists — keeps the failure on
   * `session.terminal.reason` so the terminal acknowledgment turn and the
   * board/relay see the same outcome the turn event reports.
   */
  failActiveSession(state: string, error: string): StateMachineExecutionResult {
    this.session = recordStateFailed(this.requireSession(), state, error);
    return { type: "terminal", status: "error", error };
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

  /**
   * Supersedes the active session because the parent is replacing it with a
   * brand-new state machine (a create_state_machine_definition with
   * replaceActive: true issued while a machine is still running). Records a
   * `cancelled` terminal and broadcasts the final snapshot so the superseded
   * machine's board/relay card resolves instead of dangling at its last running
   * state; the caller follows with `startSession` to install the replacement.
   * Any in-flight state work is aborted first. No-op when there is no active,
   * non-terminal session.
   */
  supersedeActiveSession(reason: string): void {
    const session = this.session;
    if (!session || session.terminal) return;
    // interrupt() may rewrite this.session (recording an interrupted state for
    // in-flight work), so read the current session after it, not the captured
    // pre-interrupt reference.
    this.interrupt("Replaced by a new state machine.");
    const current = this.requireSession();
    this.session = recordStateMachineCompleted(current, {
      state: current.currentState ?? "",
      status: "cancelled",
      reason,
    });
    this.config.onSessionChanged?.(this.session);
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

    const selectedState = findState(this.session, decision.state);
    if (!selectedState) {
      const validStates = this.session.definition.states.map((state) => state.name);
      const message = `Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`;
      this.session = recordStateFailed(
        this.session,
        this.session.currentState ?? decision.state,
        message,
      );
      return { type: "terminal", status: "error", error: message };
    }

    // Terminal states ignore overrides/inputs — they just record their
    // status and any caller-supplied reason. Every other state kind
    // honors the override + input so the caller can steer the next run.
    const isTerminal = selectedState.kind === "terminal";
    // A non-terminal selection on an already-terminal session is an explicit
    // user-driven resume; recordStateMachineReactivated clears the prior
    // terminal so the machine runs live again before the new state starts.
    if (!isTerminal && this.session.terminal) {
      this.session = recordStateMachineReactivated(this.session, selectedState.name);
    }
    const effectiveState = isTerminal
      ? selectedState
      : applyStateOverride(selectedState, decision.override);
    // Persist the override into the active definition by default so that
    // future runs of the same state pick up the tuned prompt/command/
    // schedule. The orchestrator opts out with persistOverride: false when
    // it wants to probe a variation without committing it. Skip the
    // persist when the override is a no-op (effectiveState === selectedState)
    // because applyStateOverride returns the original reference when there
    // was nothing to merge — in that case there is no drift to record.
    const shouldPersistOverride =
      !isTerminal &&
      decision.override !== undefined &&
      decision.persistOverride !== false &&
      effectiveState !== selectedState;
    if (shouldPersistOverride) {
      this.session = persistStateDefinition(this.session, effectiveState);
    }
    this.session = recordStateStarted(
      this.session,
      effectiveState,
      isTerminal ? undefined : decision.input,
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
        return this.runTerminalState(effectiveState, decision.reason);
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
        return { type: "terminal", status: "error", error: terminal.error };
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
      cwd: resolveStateCwd(state.cwd, this.config.cwd),
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
      const rawOutput = normalizeStructuredShellOutput(shellOutput, state.name);
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (shell.interruptedReason() !== undefined) {
        this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.session = recordStateFailed(this.requireSession(), state.name, message);
      return { type: "terminal", status: "error", error: message };
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
      return { type: "terminal", status: "error", error: message };
    }

    const command = renderTemplate(state.command, this.session?.currentInput ?? {});
    const shell = createShellStateHandle({
      command,
      cwd: resolveStateCwd(state.cwd, this.config.cwd),
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
      const rawOutput = normalizePollShellOutput(shellOutput, state.name);
      // Guard against a misconfigured poll gate that exits success on every
      // tick: it is read as "condition met" and handed back to the orchestrator,
      // which re-selects it and hot-loops without ever honoring intervalMs.
      // Enough back-to-back successes of the same poll is the signature of an
      // always-true gate (the `echo`/`exit 0` human-wait footgun), so fail fast
      // with an actionable message instead of spinning. See
      // consecutivePollGateSuccesses for why healthy polls cannot reach the
      // threshold. The current success is not recorded yet, hence the +1.
      const successStreak = consecutivePollGateSuccesses(this.requireSession(), state.name) + 1;
      if (successStreak >= MISCONFIGURED_POLL_GATE_THRESHOLD) {
        const message = misconfiguredPollGateMessage(state.name, successStreak);
        this.session = recordStateFailed(this.requireSession(), state.name, message);
        return { type: "terminal", status: "error", error: message };
      }
      this.session = recordStateCompleted(this.requireSession(), state.name, rawOutput);
      return { type: "state_completed", stateName: state.name, output: rawOutput };
    } catch (error) {
      if (shell.interruptedReason() !== undefined) {
        this.recordInterruptedState(run, state.name, shellPartialOutput(error));
        return { type: "interrupted" };
      }
      // Exit code not in `successCodes` (or shell error) → keep polling.
      const wakeAt =
        Date.now() + parseDurationToMs(state.intervalMs, `poll "${state.name}" intervalMs`);
      this.session = recordStateSleep(this.requireSession(), state, wakeAt);
      return { type: "sleep", wakeAt };
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      finished.resolve();
    }
  }

  private runTimerState(state: StateMachineTimerState, woke = false): StateMachineExecutionResult {
    const wakeAt = resolveTimerWakeAt(state, this.session);
    if (!woke && wakeAt > Date.now()) {
      this.session = recordStateSleep(this.requireSession(), state, wakeAt);
      return { type: "sleep", wakeAt };
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
    decisionReason?: string,
  ): Promise<StateMachineExecutionResult> {
    // Caller-supplied reason wins over the state's default — that lets the
    // model pass a specific failure explanation when selecting `failed`,
    // without losing the static `reason` on bespoke terminals when no
    // override is provided.
    const reason = decisionReason ?? state.reason;
    const terminal = { state: state.name, status: state.status, reason };
    this.session = recordStateMachineCompleted(this.requireSession(), terminal);
    return { type: "terminal", status: state.status, result: reason };
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

// Timer states accept either an absolute `wakeAt` or a relative `wakeAfterMs`.
// Each may be a raw millisecond number or a human-readable string (ISO 8601
// for `wakeAt`, `ms`-style duration for `wakeAfterMs`). Relative timers are
// resolved against the moment the parent selected the state — captured as
// `startedAt` in progress — so the wake stays stable across sleep/wake cycles
// even though the controller re-enters the state.
function resolveTimerWakeAt(
  state: StateMachineTimerState,
  session: StateMachineSession | undefined,
): number {
  if (state.wakeAt !== undefined) {
    return parseWakeAtToMs(state.wakeAt, `timer "${state.name}" wakeAt`);
  }
  if (state.wakeAfterMs === undefined) {
    throw new Error(`Timer state "${state.name}" must specify wakeAt or wakeAfterMs.`);
  }
  const wakeAfterMs = parseDurationToMs(state.wakeAfterMs, `timer "${state.name}" wakeAfterMs`);
  const startedAt = session?.progress?.states[state.name]?.startedAt ?? Date.now();
  return startedAt + wakeAfterMs;
}

function normalizeStructuredShellOutput(
  shellOutput: ShellCommandOutput,
  stateName: string,
): ShellCommandOutput & {
  parsed: Record<string, unknown>;
} {
  const stdout = shellOutput.stdout.trim();
  const stderr = shellOutput.stderr.trim();
  const cappedStdout = capStreamForPrompt(stdout, stateName, "stdout");
  // `parseStructuredOutput` returns the original text under `result` for
  // non-JSON stdout, so an uncapped fallback would smuggle the full firehose
  // back into the prompt through `parsed` even after we capped `stdout`.
  // Detect that exact fallback (`result` is the full trimmed stdout) and reuse
  // the already-capped string; genuine JSON output is small and passes through.
  const parsed = parseStructuredOutput(stdout);
  return {
    ...shellOutput,
    stdout: cappedStdout,
    stderr: capStreamForPrompt(stderr, stateName, "stderr"),
    parsed: parsed.result === stdout ? { result: cappedStdout } : parsed,
  };
}

function normalizePollShellOutput(
  shellOutput: ShellCommandOutput,
  stateName: string,
): ShellCommandOutput & { parsed: Record<string, unknown> } {
  return {
    ...shellOutput,
    stdout: capStreamForPrompt(shellOutput.stdout.trim(), stateName, "stdout"),
    stderr: capStreamForPrompt(shellOutput.stderr.trim(), stateName, "stderr"),
    // Poll `parsed` only keeps JSON objects (`{}` otherwise), so it can never
    // re-inject raw text the way the structured fallback can — no cap needed.
    parsed: parseJsonObject(shellOutput.stdout),
  };
}

/**
 * Maximum characters of a single script/poll output stream (stdout or stderr)
 * that the controller will inline into the orchestrator's state-completion
 * wake prompt. A state that pipes a whole test log or build transcript back
 * through stdout can otherwise bloat the decision turn to tens of thousands of
 * tokens, which both wastes context and makes the decision request fragile
 * enough to abort and loop. The orchestrator only needs enough to route; the
 * consuming agent state reads the full artifact from disk.
 */
const MAX_STATE_OUTPUT_STREAM_CHARS = 16_000;

/**
 * Caps one output stream for the wake prompt. Below the limit the stream is
 * returned unchanged. Above it, the full stream is written to a file under the
 * OS temp dir and the inlined value is replaced with a head+tail excerpt plus a
 * pointer to that file, so the orchestrator (or a downstream state) can read
 * the complete output on demand without it ever entering the prompt verbatim.
 */
function capStreamForPrompt(stream: string, stateName: string, label: string): string {
  if (stream.length <= MAX_STATE_OUTPUT_STREAM_CHARS) return stream;
  const overflowPath = writeOverflowFile(stream, stateName, label);
  const headChars = Math.floor(MAX_STATE_OUTPUT_STREAM_CHARS * 0.3);
  const tailChars = MAX_STATE_OUTPUT_STREAM_CHARS - headChars;
  const head = stream.slice(0, headChars);
  const tail = stream.slice(stream.length - tailChars);
  const omitted = stream.length - headChars - tailChars;
  return (
    `${head}\n\n` +
    `…[${label} truncated for the orchestrator: ${omitted} of ${stream.length} ` +
    `characters omitted. Full ${label} written to ${overflowPath} — read that file ` +
    `(or hand its path to a downstream state) if you need the complete output.]…\n\n` +
    `${tail}`
  );
}

function writeOverflowFile(content: string, stateName: string, label: string): string {
  const dir = join(tmpdir(), "duet-relay-output");
  mkdirSync(dir, { recursive: true });
  const safeState = stateName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = join(dir, `${safeState}-${label}-${Date.now()}.log`);
  writeFileSync(file, content, "utf8");
  return file;
}

function misconfiguredPollGateMessage(stateName: string, successStreak: number): string {
  return (
    `Poll state "${stateName}" completed successfully ${successStreak} times in a row with no state change in between. ` +
    "A poll's command must exit success ONLY when the awaited condition is actually met and exit non-success otherwise, so intervalMs can space out re-checks; " +
    'a command that exits 0 on every tick (e.g. `echo waiting for review`) is read as "condition met" and hot-loops the relay instead of waiting. ' +
    "If this gate is waiting on a human approval or reply, model it as an agent state that asks the user a question and stops — the reply wakes the relay — rather than as a poll."
  );
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
