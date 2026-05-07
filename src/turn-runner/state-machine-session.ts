import type {
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineSession,
  StateMachineState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE as INTERRUPTED_STATE } from "../types/state-machine.js";
import type { TurnQuestion } from "../types/protocol.js";
import type { StateMachineRunnerDecision } from "./tools.js";

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

export function currentPollState(
  stateMachine: StateMachineSession | undefined,
): StateMachinePollState | undefined {
  const currentState = stateMachine?.currentState;
  if (!stateMachine || !currentState) return undefined;
  const definitionState = findState(stateMachine, currentState);
  return definitionState?.kind === "poll" ? definitionState : undefined;
}

export function isWaitingOnPoll(stateMachine: StateMachineSession | undefined): boolean {
  return Boolean(currentPollState(stateMachine) && !stateMachine?.terminal);
}

export function recordRunnerDecision(
  stateMachine: StateMachineSession,
  decision: StateMachineRunnerDecision,
): StateMachineSession {
  return {
    ...stateMachine,
    history: [...stateMachine.history, { type: "runner_decided", timestamp: Date.now(), decision }],
    updatedAt: Date.now(),
  };
}

export function recordStateStarted(
  stateMachine: StateMachineSession,
  state: StateMachineState,
  input?: Record<string, unknown>,
): StateMachineSession {
  return {
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
  };
}

export function recordStateCompleted(
  stateMachine: StateMachineSession,
  state: string,
  output: unknown,
): StateMachineSession {
  return {
    ...stateMachine,
    history: [
      ...stateMachine.history,
      { type: "state_completed", timestamp: Date.now(), state, output },
    ],
    updatedAt: Date.now(),
  };
}

export function elapsedSinceStateStarted(
  stateMachine: StateMachineSession | undefined,
  state: string,
): number {
  const history = stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index];
    if (event.type === "state_started" && event.state === state) {
      return Math.max(0, Date.now() - event.timestamp);
    }
  }
  return 0;
}

export function recordStateFailed(
  stateMachine: StateMachineSession,
  state: string,
  error: string,
): StateMachineSession {
  const terminal = { state, status: "failed" as const, reason: error };
  return {
    ...stateMachine,
    terminal,
    history: [
      ...stateMachine.history,
      { type: "state_failed", timestamp: Date.now(), state, error },
      { type: "state_machine_completed" as const, timestamp: Date.now(), terminal },
    ],
    updatedAt: Date.now(),
  };
}

export function recordStateInterrupted(
  stateMachine: StateMachineSession,
  state: string,
  reason?: string,
  output?: { assistantText?: string } | { stdout: string; stderr: string },
): StateMachineSession {
  return {
    ...stateMachine,
    currentState: INTERRUPTED_STATE,
    currentInput: undefined,
    history: [
      ...stateMachine.history,
      {
        type: "state_interrupted" as const,
        timestamp: Date.now(),
        state,
        reason,
        output,
      },
    ],
    updatedAt: Date.now(),
  };
}

export function recordStateAskedUser(
  stateMachine: StateMachineSession,
  state: string,
  questions: TurnQuestion[],
): StateMachineSession {
  return {
    ...stateMachine,
    history: [
      ...stateMachine.history,
      { type: "state_asked_user" as const, timestamp: Date.now(), state, questions },
    ],
    updatedAt: Date.now(),
  };
}

export function recordStateMachineCompleted(
  stateMachine: StateMachineSession,
  terminal: { state: string; status: "completed" | "failed" | "cancelled"; reason?: string },
): StateMachineSession {
  return {
    ...stateMachine,
    terminal,
    history: [
      ...stateMachine.history,
      { type: "state_machine_completed" as const, timestamp: Date.now(), terminal },
    ],
    updatedAt: Date.now(),
  };
}
