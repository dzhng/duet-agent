import type {
  StateMachineDefinition,
  StateMachineParkState,
  StateMachinePollState,
  StateMachineProgress,
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineStateProgress,
  StateMachineState,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE as INTERRUPTED_STATE } from "../types/state-machine.js";
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

/** The active inert park, if the machine currently holds without execution or a wake. */
export function currentParkState(
  stateMachine: StateMachineSession | undefined,
): StateMachineParkState | undefined {
  if (!stateMachine?.currentState || stateMachine.terminal) return undefined;
  const state = findState(stateMachine, stateMachine.currentState);
  return state?.kind === "park" ? state : undefined;
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

/**
 * Threshold for the misconfigured poll-gate heuristic: how many back-to-back
 * successful completions of the same poll state — with no other state running
 * in between — we treat as a runaway always-succeeds poll rather than
 * legitimate fast polling. Kept small but >1 so a poll that genuinely
 * completes once and is re-selected once does not trip the guard.
 */
export const MISCONFIGURED_POLL_GATE_THRESHOLD = 3;

/**
 * Count how many times in a row the given poll state has already completed
 * successfully with no *other* state running in between.
 *
 * Why this shape catches the footgun without false positives: a healthy poll
 * either exits non-success — which records a sleep in `progress`, never a
 * `state_completed` in `history`, so it cannot inflate this count — or it
 * eventually drives the machine into a different state, whose event breaks the
 * streak. The only way to accumulate consecutive same-poll completions is an
 * always-exit-0 command (e.g. `echo waiting for review`) being re-selected as
 * the same gate, which is exactly the hot-loop we want to surface. The
 * current in-flight success is not yet recorded when the turn loop calls
 * this, so the returned count reflects only prior completions.
 */
export function consecutivePollGateSuccesses(
  stateMachine: StateMachineSession,
  pollName: string,
): number {
  let streak = 0;
  for (let i = stateMachine.history.length - 1; i >= 0; i--) {
    const event = stateMachine.history[i];
    if (event.type === "state_completed") {
      if (event.state !== pollName) break;
      streak++;
      continue;
    }
    // Events naming this same poll (its own selection/run cycle) are noise
    // between two of its completions; an event naming a *different* state
    // means the machine actually moved on, so the streak is over.
    if (
      (event.type === "state_started" ||
        event.type === "state_failed" ||
        event.type === "state_interrupted" ||
        event.type === "state_definition_updated") &&
      event.state !== pollName
    ) {
      break;
    }
  }
  return streak;
}

/**
 * Threshold for the no-progress re-selection guard: how many times in a row the
 * orchestrator may select the SAME state — with no different state running in
 * between — before the runner injects a loop warning into the next decision
 * prompt. Set above a normal retry-with-correction streak (re-running a state
 * two or three times with a fixed `override.prompt` is legitimate) so the
 * warning targets idle "holding" loops where the parent re-selects executable
 * work to "keep waiting" rather than productive retries. Park states are
 * exempt because re-selecting the same park is a legal no-work hold.
 */
export const REPEATED_SELECTION_LOOP_THRESHOLD = 5;

/**
 * Time window for the no-progress re-selection guard. Repeated selections only
 * read as a hot loop when they happen close together; a state deliberately
 * re-run hours apart is normal cadence, not a loop. Only a streak whose span
 * stays within this window triggers the warning, so a slow, legitimate revisit
 * pattern is never flagged.
 */
export const REPEATED_SELECTION_LOOP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Measure the current run of back-to-back selections of `stateName` with no
 * other state started in between, returning the streak length and the elapsed
 * span from the streak's first selection to its most recent.
 *
 * This surfaces the idle-loop footgun where the orchestrator re-selects a
 * "holding" state again and again to "keep waiting" — a no-op, since selecting a
 * state runs it immediately rather than suspending the machine. Unlike
 * `consecutivePollGateSuccesses` (which counts completions of an always-true
 * poll), this telemetry counts `state_started` events for every state kind;
 * the trip policy separately exempts park. A lifecycle event naming a
 * *different* state means the machine actually moved on, so the streak resets
 * and a normal plan that revisits a state after doing other work never accumulates.
 */
export function repeatedStateSelectionStreak(
  stateMachine: StateMachineSession,
  stateName: string,
): { count: number; spanMs: number } {
  let count = 0;
  let earliest: number | undefined;
  let latest: number | undefined;
  for (let i = stateMachine.history.length - 1; i >= 0; i--) {
    const event = stateMachine.history[i];
    if (event.type === "state_started") {
      if (event.state !== stateName) break;
      count++;
      earliest = event.timestamp;
      if (latest === undefined) latest = event.timestamp;
      continue;
    }
    // Lifecycle events naming this same state are noise inside one run cycle;
    // an event naming a *different* state means the machine moved on, ending
    // the streak. runner_decided / state_machine_* carry no comparable state.
    if (
      (event.type === "state_completed" ||
        event.type === "state_failed" ||
        event.type === "state_interrupted" ||
        event.type === "state_definition_updated" ||
        event.type === "state_machine_reactivated") &&
      event.state !== stateName
    ) {
      break;
    }
  }
  const spanMs = earliest !== undefined && latest !== undefined ? latest - earliest : 0;
  return { count, spanMs };
}

/**
 * Apply the no-progress loop policy to a session: return the streak length when
 * `stateName` has just been re-selected enough times in a tight enough window to
 * read as an idle hot loop, or undefined otherwise. This is the single source of
 * truth for the trip condition — the turn runner uses the returned count to word
 * its loop-warning reminder, and tests assert against this same function rather
 * than re-deriving the threshold/window comparison. Park always returns
 * undefined because repeated park selection deliberately performs no work.
 */
export function repeatedSelectionLoopCount(
  stateMachine: StateMachineSession,
  stateName: string,
): number | undefined {
  if (findState(stateMachine, stateName)?.kind === "park") return undefined;
  const { count, spanMs } = repeatedStateSelectionStreak(stateMachine, stateName);
  if (count < REPEATED_SELECTION_LOOP_THRESHOLD || spanMs > REPEATED_SELECTION_LOOP_WINDOW_MS) {
    return undefined;
  }
  return count;
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
  const terminal = { state, status: "error" as const, reason: error };
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

/**
 * Clear the terminal record so a previously-finished session runs as live
 * again. Reactivation is only legal as an explicit user-driven resume: the
 * parent selects a non-terminal state on a session whose `terminal` is set
 * because the user asked it to redo or continue the finished work. Both
 * `terminal` and the one-shot `terminalAcknowledged` flag are dropped so the
 * next terminal this session reaches gets its own acknowledgment turn, and the
 * prior outcome is preserved on a `state_machine_reactivated` event so replay
 * shows the completed→running transition rather than a silent rewrite.
 */
export function recordStateMachineReactivated(
  stateMachine: StateMachineSession,
  state: string,
): StateMachineSession {
  const priorTerminal = stateMachine.terminal;
  if (!priorTerminal) return stateMachine;
  const now = Date.now();
  return {
    ...stateMachine,
    terminal: undefined,
    terminalAcknowledged: undefined,
    history: appendHistory(stateMachine.history, {
      type: "state_machine_reactivated",
      timestamp: now,
      state,
      priorTerminal,
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
