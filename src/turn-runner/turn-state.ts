import { isVirtualModel, type RoutingTable } from "../model-routing/table.js";
import type { StateMachineDefinition } from "../types/state-machine.js";
import type {
  TurnMode,
  TurnOptions,
  TurnRunnerTerminalStatus,
  TurnState,
  TurnTerminalEvent,
} from "../types/protocol.js";

/** Recover only executable selections from saved state, never transcript or workflow history. */
export function restoreSavedExecutionSelections(
  state: TurnState,
  supplied: TurnOptions | undefined,
  table: RoutingTable,
  normalize: (name: string | undefined) => string | undefined,
): TurnState {
  const chatModel = (name: string | undefined) =>
    name !== undefined && isVirtualModel(name, table) ? name : normalize(name);
  const definition = (value: StateMachineDefinition): StateMachineDefinition => ({
    ...value,
    states: value.states.map((entry) =>
      entry.kind === "agent" && entry.model !== undefined
        ? { ...entry, model: chatModel(entry.model) }
        : entry,
    ),
  });
  return {
    ...state,
    options: {
      model:
        supplied?.model === undefined || supplied.model === state.options?.model
          ? chatModel(state.options?.model)
          : supplied.model,
      // Memory actors resolve concrete catalog names; chat tiers do not shadow them.
      memoryModel:
        supplied?.memoryModel === undefined || supplied.memoryModel === state.options?.memoryModel
          ? normalize(state.options?.memoryModel)
          : supplied.memoryModel,
      thinkingLevel: supplied?.thinkingLevel ?? state.options?.thinkingLevel,
    },
    mode: typeof state.mode === "object" ? definition(state.mode) : state.mode,
    ...(state.stateMachine
      ? {
          stateMachine: {
            ...state.stateMachine,
            definition: definition(state.stateMachine.definition),
          },
        }
      : {}),
  };
}

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
