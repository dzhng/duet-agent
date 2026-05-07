import type {
  TurnMode,
  TurnOptions,
  TurnRunnerTerminalStatus,
  TurnState,
  TurnTerminalEvent,
} from "../types/protocol.js";
import type { StateMachinePollState } from "../types/state-machine.js";

export function createInitialTurnState(mode: TurnMode, options?: TurnOptions): TurnState {
  return {
    status: "running",
    mode,
    options,
    agent: {
      status: "running",
      messages: [],
    },
  };
}

export function withStateMachine(
  turnState: TurnState,
  update: (stateMachine: NonNullable<TurnState["stateMachine"]>) => TurnState["stateMachine"],
): TurnState {
  if (!turnState.stateMachine) return turnState;
  return { ...turnState, stateMachine: update(turnState.stateMachine) };
}

export function sleepPollState(
  turnState: TurnState,
  state: StateMachinePollState,
): TurnTerminalEvent {
  return {
    type: "sleep",
    wakeAt: Date.now() + state.intervalMs,
    state: { ...turnState, status: "sleeping" },
  };
}

export function completeTurn(
  state: TurnState,
  status: TurnRunnerTerminalStatus,
  result?: string,
  error?: string,
): TurnTerminalEvent {
  return {
    type: "complete",
    status,
    result,
    error,
    state: {
      ...state,
      status,
    },
  };
}

export function copyOptionalArray<T>(values: T[] | undefined): T[] | undefined {
  return values ? [...values] : undefined;
}
