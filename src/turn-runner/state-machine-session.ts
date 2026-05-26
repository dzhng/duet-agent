import type {
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineProgress,
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineStateProgress,
  StateMachineState,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE as INTERRUPTED_STATE } from "../types/state-machine.js";
import type { TurnQuestion } from "../types/protocol.js";
import type { StateMachineRunnerDecision } from "./tools.js";

/**
 * Hard cap on retained `StateMachineSession.history` entries. Long-lived
 * relays (poll loops, follow-up cadences) can otherwise grow history
 * unboundedly, which bloats every emitted `state_machine` event payload
 * and every persisted session snapshot. The cap keeps the most recent
 * transitions — what UIs and debuggers actually look at — and drops
 * the oldest. The starting `state_machine_started` marker can fall off
 * with the rest; consumers must not rely on its presence.
 */
export const STATE_MACHINE_HISTORY_LIMIT = 100;

function appendHistory(
  history: StateMachineSessionEvent[],
  ...events: StateMachineSessionEvent[]
): StateMachineSessionEvent[] {
  const combined = [...history, ...events];
  return combined.length > STATE_MACHINE_HISTORY_LIMIT
    ? combined.slice(combined.length - STATE_MACHINE_HISTORY_LIMIT)
    : combined;
}

export function createStateMachineSession(
  prompt: string,
  definition: StateMachineDefinition,
  currentState: string,
): StateMachineSession {
  const now = Date.now();
  return {
    definition,
    prompt,
    currentState,
    history: [{ type: "state_machine_started", timestamp: now }],
    createdAt: now,
    updatedAt: now,
  };
}

export function findState(
  stateMachine: StateMachineSession,
  name: string,
): StateMachineState | undefined {
  return stateMachine.definition.states.find((state) => state.name === name);
}

export type StateMachineScheduledState = StateMachinePollState | StateMachineTimerState;

export function currentScheduledState(
  stateMachine: StateMachineSession | undefined,
): StateMachineScheduledState | undefined {
  const currentState = stateMachine?.currentState;
  if (!stateMachine || !currentState) return undefined;
  const definitionState = findState(stateMachine, currentState);
  return definitionState?.kind === "poll" || definitionState?.kind === "timer"
    ? definitionState
    : undefined;
}

export function isWaitingOnScheduledState(stateMachine: StateMachineSession | undefined): boolean {
  return Boolean(currentScheduledState(stateMachine) && !stateMachine?.terminal);
}

export function recordRunnerDecision(
  stateMachine: StateMachineSession,
  decision: StateMachineRunnerDecision,
): StateMachineSession {
  return {
    ...stateMachine,
    history: appendHistory(stateMachine.history, {
      type: "runner_decided",
      timestamp: Date.now(),
      decision,
    }),
    updatedAt: Date.now(),
  };
}

/**
 * Replace one state in the active definition with a merged version,
 * recording a state_definition_updated event so the persistence is
 * visible in session history. Callers should pass the already-merged
 * state (typically produced by `applyStateOverride`). The session's
 * `definition.states` array is rebuilt immutably; any other reference to
 * the previous definition object is unaffected.
 */
export function persistStateDefinition(
  stateMachine: StateMachineSession,
  updatedState: StateMachineState,
): StateMachineSession {
  const now = Date.now();
  const states = stateMachine.definition.states.map((state) =>
    state.name === updatedState.name ? updatedState : state,
  );
  return {
    ...stateMachine,
    definition: { ...stateMachine.definition, states },
    history: appendHistory(stateMachine.history, {
      type: "state_definition_updated",
      timestamp: now,
      state: updatedState.name,
      updatedState,
    }),
    updatedAt: now,
  };
}

export function recordStateStarted(
  stateMachine: StateMachineSession,
  state: StateMachineState,
  input?: Record<string, unknown>,
): StateMachineSession {
  const now = Date.now();
  const stateMachineWithoutScheduledWake = {
    ...stateMachine,
    progress: clearProgressWakeTimes(stateMachine.progress),
  };
  return {
    ...stateMachine,
    currentState: state.name,
    currentInput: input,
    progress: updateStateProgress(
      stateMachineWithoutScheduledWake,
      state.name,
      state.kind,
      (entry) => ({
        ...entry,
        runs: entry.runs + 1,
        startedAt: now,
      }),
    ),
    history: appendHistory(stateMachine.history, {
      type: "state_started",
      timestamp: now,
      state: state.name,
      input,
    }),
    updatedAt: now,
  };
}

export function recordStateCompleted(
  stateMachine: StateMachineSession,
  state: string,
  output: unknown,
): StateMachineSession {
  const now = Date.now();
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(stateMachine.history, {
      type: "state_completed",
      timestamp: now,
      state,
      output,
    }),
    updatedAt: now,
  };
}

export function recordStateSleep(
  stateMachine: StateMachineSession,
  state: StateMachineScheduledState,
  wakeAt: number,
): StateMachineSession {
  const now = Date.now();
  return {
    ...stateMachine,
    progress: updateStateProgress(stateMachine, state.name, state.kind, (entry) => ({
      ...entry,
      sleeps: entry.sleeps + 1,
      nextWakeAt: wakeAt,
    })),
    updatedAt: now,
  };
}

export function elapsedSinceStateStarted(
  stateMachine: StateMachineSession | undefined,
  state: string,
): number {
  const startedAt = stateMachine?.progress?.states[state]?.startedAt;
  return startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
}

export function recordStateFailed(
  stateMachine: StateMachineSession,
  state: string,
  error: string,
): StateMachineSession {
  const now = Date.now();
  const terminal = { state, status: "failed" as const, reason: error };
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    terminal,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(
      stateMachine.history,
      { type: "state_failed", timestamp: now, state, error },
      { type: "state_machine_completed" as const, timestamp: now, terminal },
    ),
    updatedAt: now,
  };
}

export function recordStateInterrupted(
  stateMachine: StateMachineSession,
  state: string,
  reason?: string,
  output?: { assistantText?: string } | { stdout: string; stderr: string },
): StateMachineSession {
  const now = Date.now();
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    currentState: INTERRUPTED_STATE,
    currentInput: undefined,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(stateMachine.history, {
      type: "state_interrupted" as const,
      timestamp: now,
      state,
      reason,
      output,
    }),
    updatedAt: now,
  };
}

export function recordStateAskedUser(
  stateMachine: StateMachineSession,
  state: string,
  questions: TurnQuestion[],
): StateMachineSession {
  const now = Date.now();
  return {
    ...stateMachine,
    history: appendHistory(stateMachine.history, {
      type: "state_asked_user" as const,
      timestamp: now,
      state,
      questions,
    }),
    updatedAt: now,
  };
}

export function recordStateMachineCompleted(
  stateMachine: StateMachineSession,
  terminal: { state: string; status: "completed" | "failed" | "cancelled"; reason?: string },
): StateMachineSession {
  const now = Date.now();
  return {
    ...stateMachine,
    terminal,
    history: appendHistory(stateMachine.history, {
      type: "state_machine_completed" as const,
      timestamp: now,
      terminal,
    }),
    updatedAt: now,
  };
}

function updateStateProgress(
  stateMachine: StateMachineSession,
  state: string,
  kind: StateMachineState["kind"] | undefined,
  update: (entry: StateMachineStateProgress) => StateMachineStateProgress,
): StateMachineProgress {
  const states = stateMachine.progress?.states ?? {};
  const current = normalizeStateProgress(states[state], kind);
  return {
    states: {
      ...states,
      [state]: update(current),
    },
  };
}

function normalizeStateProgress(
  entry: StateMachineStateProgress | undefined,
  kind: StateMachineState["kind"] | undefined,
): StateMachineStateProgress {
  return {
    kind: entry?.kind ?? kind,
    runs: entry?.runs ?? 0,
    sleeps: entry?.sleeps ?? 0,
    nextWakeAt: entry?.nextWakeAt,
    startedAt: entry?.startedAt,
  };
}

function clearProgressWakeTimes(
  progress: StateMachineProgress | undefined,
): StateMachineProgress | undefined {
  if (!progress) return undefined;
  const states: Record<string, StateMachineStateProgress> = {};
  for (const [state, entry] of Object.entries(progress.states)) {
    states[state] = { ...entry, nextWakeAt: undefined };
  }
  return { states };
}
