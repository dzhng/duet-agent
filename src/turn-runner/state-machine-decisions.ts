import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnQuestion } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachineSession,
  StateMachineState,
  StateMachineTerminalResult,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import { parseDurationToMs, parseWakeAtToMs } from "./duration.js";
import {
  consecutivePollGateSuccesses,
  createStateMachineSession,
  currentScheduledState,
  elapsedSinceStateStarted,
  findState,
  MISCONFIGURED_POLL_GATE_THRESHOLD,
  persistStateDefinition,
  recordRunnerDecision,
  recordStateAskedUser,
  recordStateCompleted,
  recordStateFailed,
  recordStateInterrupted,
  recordStateMachineCompleted,
  recordStateMachineReactivated,
  recordStateSleep,
  recordStateStarted,
} from "./state-machine-session.js";
import type { ShellCommandOutput, ShellPartialOutput } from "./shell-state-handle.js";
import type { SubagentResult, SubagentSpec } from "./subagent.js";
import type { StateMachineRunnerDecision, StateMachineStateOverride } from "./tools.js";

export {
  consecutivePollGateSuccesses,
  MISCONFIGURED_POLL_GATE_THRESHOLD,
  repeatedSelectionLoopCount,
  repeatedStateSelectionStreak,
  REPEATED_SELECTION_LOOP_THRESHOLD,
  REPEATED_SELECTION_LOOP_WINDOW_MS,
} from "./state-machine-session.js";

type StateCompletedOutcome = { type: "state_completed"; stateName: string; output?: unknown };
type TerminalOutcome = {
  type: "terminal";
  status: StateMachineTerminalResult["status"];
  result?: string;
  error?: string;
};
type AskOutcome = { type: "ask"; questions: TurnQuestion[] };
type SleepOutcome = { type: "sleep"; wakeAt: number };
type InterruptedOutcome = { type: "interrupted" };

/** Serializable shell work selected by state-machine policy. */
export interface ShellSpec {
  /** Rendered command for this state attempt. */
  command: string;
  /** State-local working directory; the turn loop resolves it against its base cwd. */
  cwd?: string;
  /** Hard runtime limit for script states; polls use their timeout as a session-level policy. */
  timeoutMs?: number;
  /** Exit codes that settle the shell attempt successfully. */
  successCodes?: number[];
}

/** Policy needed to fold a non-successful shell attempt back into a scheduled poll. */
export interface PollPolicy {
  /** Delay before the next poll attempt. */
  intervalMs: number | string;
}

/** Execution-free work description produced by a state-machine decision. */
export type PlannedWork =
  | { run: { subagent: SubagentSpec; stateName: string } }
  | { run: { shell: ShellSpec; stateName: string; pollPolicy?: PollPolicy } }
  | { schedule: { wakeAt: number; stateName: string } }
  | {
      terminal: Omit<TerminalOutcome, "type"> & {
        stateName: string;
        ledger: "recorded" | "failed" | "completed";
        notifyStarted: boolean;
      };
    };

export interface PlannedDecision {
  /** Updated durable ledger after applying and recording the decision. */
  session: StateMachineSession;
  /** Execution or scheduling work the turn loop performs. */
  work: PlannedWork;
}

export type SettledDecision =
  | { session: StateMachineSession; outcome: StateCompletedOutcome }
  | { session: StateMachineSession; outcome: TerminalOutcome }
  | { session: StateMachineSession; outcome: AskOutcome }
  | { session: StateMachineSession; outcome: SleepOutcome }
  | { session: StateMachineSession; outcome: InterruptedOutcome };

export type ShellSettlement =
  | { type: "completed"; output: ShellCommandOutput }
  | { type: "failed"; error: string }
  | { type: "interrupted"; reason?: string };

export type TimerSettlement = {
  type: "completed";
  output: { elapsedMs: number; timestamp: number };
};

export function hydrate(
  stateMachine: StateMachineSession | undefined,
): StateMachineSession | undefined {
  return stateMachine;
}

export function getSession(
  stateMachine: StateMachineSession | undefined,
): StateMachineSession | undefined {
  return stateMachine;
}

export function startSession(input: {
  prompt: string;
  definition: StateMachineDefinition;
  currentState: string;
}): StateMachineSession {
  return createStateMachineSession(input.prompt, input.definition, input.currentState);
}

export function markTerminalAcknowledged(session: StateMachineSession): StateMachineSession {
  if (!session.terminal || session.terminalAcknowledged) return session;
  return {
    ...session,
    terminalAcknowledged: true,
    updatedAt: Date.now(),
  };
}

export function failActiveSession(
  session: StateMachineSession,
  state: string,
  error: string,
): SettledDecision {
  return {
    session: recordStateFailed(session, state, error),
    outcome: { type: "terminal", status: "error", error },
  };
}

export function supersede(session: StateMachineSession, reason: string): StateMachineSession {
  return recordStateMachineCompleted(session, {
    state: session.currentState ?? "",
    status: "cancelled",
    reason,
  });
}

export function planDecision(
  stateMachine: StateMachineSession,
  decision: StateMachineRunnerDecision,
  now = Date.now(),
): PlannedDecision {
  let session = recordRunnerDecision(stateMachine, decision);
  const selectedState = findState(session, decision.state);
  if (!selectedState) {
    const validStates = session.definition.states.map((state) => state.name);
    const message = `Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`;
    session = recordStateFailed(session, session.currentState ?? decision.state, message);
    return {
      session,
      work: {
        terminal: {
          status: "error",
          error: message,
          stateName: session.currentState ?? decision.state,
          ledger: "recorded",
          notifyStarted: false,
        },
      },
    };
  }

  const isTerminal = selectedState.kind === "terminal";
  if (!isTerminal && session.terminal) {
    session = recordStateMachineReactivated(session, selectedState.name);
  }
  const effectiveState = isTerminal
    ? selectedState
    : applyStateOverride(selectedState, decision.override);
  const shouldPersistOverride =
    !isTerminal &&
    decision.override !== undefined &&
    decision.persistOverride !== false &&
    effectiveState !== selectedState;
  if (shouldPersistOverride) {
    session = persistStateDefinition(session, effectiveState);
  }
  session = recordStateStarted(session, effectiveState, isTerminal ? undefined : decision.input);

  switch (effectiveState.kind) {
    case "agent":
      return {
        session,
        work: {
          run: {
            subagent: subagentSpec(effectiveState, session.currentInput),
            stateName: effectiveState.name,
          },
        },
      };
    case "script":
      return {
        session,
        work: {
          run: {
            shell: {
              command: renderTemplate(effectiveState.command, session.currentInput ?? {}),
              cwd: effectiveState.cwd,
              timeoutMs: effectiveState.timeoutMs,
              successCodes: effectiveState.successCodes,
            },
            stateName: effectiveState.name,
          },
        },
      };
    case "poll": {
      const elapsedMs = elapsedSinceStateStarted(session, effectiveState.name);
      if (effectiveState.timeoutMs !== undefined && elapsedMs >= effectiveState.timeoutMs) {
        const message = `Poll state "${effectiveState.name}" timed out after ${elapsedMs}ms.`;
        return {
          session,
          work: {
            terminal: {
              status: "error",
              error: message,
              stateName: effectiveState.name,
              ledger: "failed",
              notifyStarted: true,
            },
          },
        };
      }
      return {
        session,
        work: {
          run: {
            shell: {
              command: renderTemplate(effectiveState.command, session.currentInput ?? {}),
              cwd: effectiveState.cwd,
              successCodes: effectiveState.successCodes,
            },
            stateName: effectiveState.name,
            pollPolicy: { intervalMs: effectiveState.intervalMs },
          },
        },
      };
    }
    case "timer": {
      const wakeAt = resolveTimerWakeAt(effectiveState, session, now);
      return { session, work: { schedule: { wakeAt, stateName: effectiveState.name } } };
    }
    case "terminal": {
      const reason = decision.reason ?? effectiveState.reason;
      return {
        session,
        work: {
          terminal: {
            status: effectiveState.status,
            result: reason,
            stateName: effectiveState.name,
            ledger: "completed",
            notifyStarted: true,
          },
        },
      };
    }
  }
}

export function planWake(
  stateMachine: StateMachineSession | undefined,
  now = Date.now(),
): PlannedDecision | undefined {
  const state = currentScheduledState(stateMachine);
  if (!state || !stateMachine) return undefined;
  if (state.kind === "poll") {
    const elapsedMs = elapsedSinceStateStarted(stateMachine, state.name);
    if (state.timeoutMs !== undefined && elapsedMs >= state.timeoutMs) {
      const message = `Poll state "${state.name}" timed out after ${elapsedMs}ms.`;
      return {
        session: stateMachine,
        work: {
          terminal: {
            status: "error",
            error: message,
            stateName: state.name,
            ledger: "failed",
            notifyStarted: false,
          },
        },
      };
    }
    return {
      session: stateMachine,
      work: {
        run: {
          shell: {
            command: renderTemplate(state.command, stateMachine.currentInput ?? {}),
            cwd: state.cwd,
            successCodes: state.successCodes,
          },
          stateName: state.name,
          pollPolicy: { intervalMs: state.intervalMs },
        },
      },
    };
  }
  resolveTimerWakeAt(state, stateMachine, now);
  return {
    session: stateMachine,
    // A wake command means the persisted timer has fired. The turn loop's
    // schedule branch completes immediately when wakeAt is not in the future;
    // preserve the old `runTimerState(state, true)` behavior even if the
    // caller's clock arrives a few milliseconds before the stored deadline.
    work: { schedule: { wakeAt: now, stateName: state.name } },
  };
}

export function recordScheduled(
  stateMachine: StateMachineSession,
  stateName: string,
  wakeAt: number,
): SettledDecision {
  const state = findState(stateMachine, stateName);
  if (!state || (state.kind !== "poll" && state.kind !== "timer")) {
    throw new Error(`Scheduled state "${stateName}" is missing from the active definition.`);
  }
  return {
    session: recordStateSleep(stateMachine, state, wakeAt),
    outcome: { type: "sleep", wakeAt },
  };
}

export function recordPlannedTerminal(
  stateMachine: StateMachineSession,
  terminal: Extract<PlannedWork, { terminal: unknown }>["terminal"],
): SettledDecision {
  const outcome: TerminalOutcome = {
    type: "terminal",
    status: terminal.status,
    ...(terminal.result !== undefined ? { result: terminal.result } : {}),
    ...(terminal.error !== undefined ? { error: terminal.error } : {}),
  };
  if (terminal.ledger === "recorded") return { session: stateMachine, outcome };
  if (terminal.ledger === "failed") {
    return {
      session: recordStateFailed(stateMachine, terminal.stateName, terminal.error ?? "Failed"),
      outcome,
    };
  }
  return {
    session: recordStateMachineCompleted(stateMachine, {
      state: terminal.stateName,
      status: terminal.status === "error" ? "failed" : terminal.status,
      reason: terminal.result,
    }),
    outcome,
  };
}

export function recordSettled(
  stateMachine: StateMachineSession,
  stateName: string,
  kind: "agent" | "script" | "poll" | "timer",
  result: SubagentResult | ShellSettlement | TimerSettlement,
  partial?: { assistantText?: string } | ShellPartialOutput,
  now = Date.now(),
): SettledDecision {
  if (result.type === "ask") {
    return {
      session: recordStateAskedUser(stateMachine, stateName, result.questions),
      outcome: { type: "ask", questions: result.questions },
    };
  }
  if (result.type === "complete") {
    const output = { result: result.result };
    return {
      session: recordStateCompleted(stateMachine, stateName, output),
      outcome: { type: "state_completed", stateName, output },
    };
  }
  if (result.type === "interrupted") {
    const session = recordInterrupted(
      stateMachine,
      stateName,
      ("reason" in result ? result.reason : undefined) ?? "Interrupted",
      partial,
    );
    return { session, outcome: { type: "interrupted" } };
  }
  if (result.type === "failed") {
    if (kind === "poll") {
      const state = findState(stateMachine, stateName);
      if (!state || state.kind !== "poll") {
        throw new Error(`Poll state "${stateName}" is missing from the active definition.`);
      }
      const wakeAt = now + parseDurationToMs(state.intervalMs, `poll "${stateName}" intervalMs`);
      return {
        session: recordStateSleep(stateMachine, state, wakeAt),
        outcome: { type: "sleep", wakeAt },
      };
    }
    return {
      session: recordStateFailed(stateMachine, stateName, result.error),
      outcome: { type: "terminal", status: "error", error: result.error },
    };
  }

  if (kind === "timer") {
    return {
      session: recordStateCompleted(stateMachine, stateName, result.output),
      outcome: { type: "state_completed", stateName, output: result.output },
    };
  }
  if (!isShellCommandOutput(result.output)) {
    throw new Error(`${kind} state "${stateName}" settled without shell output.`);
  }
  const output =
    kind === "poll"
      ? normalizePollShellOutput(result.output, stateName)
      : normalizeStructuredShellOutput(result.output, stateName);
  if (kind === "poll") {
    const successStreak = consecutivePollGateSuccesses(stateMachine, stateName) + 1;
    if (successStreak >= MISCONFIGURED_POLL_GATE_THRESHOLD) {
      const message = misconfiguredPollGateMessage(stateName, successStreak);
      return {
        session: recordStateFailed(stateMachine, stateName, message),
        outcome: { type: "terminal", status: "error", error: message },
      };
    }
  }
  return {
    session: recordStateCompleted(stateMachine, stateName, output),
    outcome: { type: "state_completed", stateName, output },
  };
}

function subagentSpec(
  state: StateMachineAgentState,
  input: Record<string, unknown> | undefined,
): SubagentSpec {
  return {
    prompt: renderTemplate(state.prompt, input ?? {}),
    ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
    ...(state.allowedSkills ? { allowedSkills: state.allowedSkills } : {}),
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
    ...(state.forkContext ? { forkContext: true } : {}),
  };
}

export function applyStateOverride(
  state: StateMachineState,
  override: StateMachineStateOverride | undefined,
): StateMachineState {
  if (!override || override.kind !== state.kind) return state;
  const merged = { ...state, ...override.state } as StateMachineState;
  if (merged.kind === "timer" && override.kind === "timer") {
    const overrideState = override.state;
    if ("wakeAt" in overrideState && overrideState.wakeAt !== undefined) {
      delete merged.wakeAfterMs;
    } else if ("wakeAfterMs" in overrideState && overrideState.wakeAfterMs !== undefined) {
      delete merged.wakeAt;
    }
  }
  return merged;
}

function resolveTimerWakeAt(
  state: StateMachineTimerState,
  session: StateMachineSession,
  now: number,
): number {
  if (state.wakeAt !== undefined) {
    return parseWakeAtToMs(state.wakeAt, `timer "${state.name}" wakeAt`);
  }
  if (state.wakeAfterMs === undefined) {
    throw new Error(`Timer state "${state.name}" must specify wakeAt or wakeAfterMs.`);
  }
  const wakeAfterMs = parseDurationToMs(state.wakeAfterMs, `timer "${state.name}" wakeAfterMs`);
  const startedAt = session.progress?.states[state.name]?.startedAt ?? now;
  return startedAt + wakeAfterMs;
}

export function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = path.split(".").reduce<unknown>((current, key) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[key];
    }, input);
    return value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  });
}

function normalizeStructuredShellOutput(
  shellOutput: ShellCommandOutput,
  stateName: string,
): ShellCommandOutput & { parsed: Record<string, unknown> } {
  const stdout = shellOutput.stdout.trim();
  const stderr = shellOutput.stderr.trim();
  const cappedStdout = capStreamForPrompt(stdout, stateName, "stdout");
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
    parsed: parseJsonObject(shellOutput.stdout),
  };
}

const MAX_STATE_OUTPUT_STREAM_CHARS = 16_000;

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

export function parseStructuredOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  } catch {
    return { result: trimmed };
  }
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isShellCommandOutput(output: unknown): output is ShellCommandOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "stdout" in output &&
    "stderr" in output &&
    "exitCode" in output
  );
}

function recordInterrupted(
  session: StateMachineSession,
  stateName: string,
  reason: string,
  output?: { assistantText?: string } | ShellPartialOutput,
): StateMachineSession {
  const last = session.history.at(-1);
  if (
    session.currentState === INTERRUPTED_STATE_MACHINE_STATE &&
    last?.type === "state_interrupted" &&
    last.state === stateName
  ) {
    return {
      ...session,
      history: [
        ...session.history.slice(0, -1),
        { ...last, reason: reason ?? last.reason, output: output ?? last.output },
      ],
      updatedAt: Date.now(),
    };
  }
  return recordStateInterrupted(session, stateName, reason, output);
}

function misconfiguredPollGateMessage(stateName: string, successStreak: number): string {
  return (
    `Poll state "${stateName}" completed successfully ${successStreak} times in a row with no state change in between. ` +
    "A poll's command must exit success ONLY when the awaited condition is actually met and exit non-success otherwise, so intervalMs can space out re-checks; " +
    'a command that exits 0 on every tick (e.g. `echo waiting for review`) is read as "condition met" and hot-loops the relay instead of waiting. ' +
    "If this gate is waiting on a human approval or reply, model it as an agent state that asks the user a question and stops — the reply wakes the relay — rather than as a poll."
  );
}
