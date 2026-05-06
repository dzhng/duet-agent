import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TurnRunner, type TurnEventHandler } from "../turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnAnswerCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptBehavior,
  TurnQuestion,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
} from "../types/protocol.js";
import type { StateMachinePollState } from "../types/state-machine.js";

export interface SessionStartInput {
  prompt: string;
  mode?: TurnMode;
  options?: TurnOptions;
}

export interface SessionPromptInput {
  message: string;
  behavior?: TurnPromptBehavior;
  options?: TurnOptions;
}

export interface SessionAnswerInput {
  questions: TurnQuestion[];
  answers: Record<string, string>;
  behavior?: TurnPromptBehavior;
  options?: TurnOptions;
}

export interface SessionEditFollowUpQueueInput {
  prompts: string[];
}

export type SessionEventHandler = (event: TurnEvent) => void;

export interface SessionTurnRunner {
  turn(command: TurnCommand): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void;
  subscribe(handler: TurnEventHandler): () => void;
  dispose(): Promise<void>;
}

export interface SessionOptions {
  id: string;
  /** Concrete directory owned by this session. The manager creates it before construction. */
  sessionPath: string;
  runner?: SessionTurnRunner;
  initialState?: TurnState;
  resumeFromStorage?: boolean;
}

export class Session {
  readonly id: string;
  private readonly runner: SessionTurnRunner;
  /** Directory owned by this session. State persistence writes `state.json` inside it. */
  private readonly sessionPath: string;
  /** Subscribers interested in this single session's raw turn-runner events. */
  private readonly eventHandlers = new Set<SessionEventHandler>();
  /** Removes the session's subscription to its owned runner during disposal. */
  private readonly unsubscribeRunner: () => void;
  /** Latest turn state snapshot used to continue prompts, answers, wakes, and interrupts. */
  private state?: TurnState;
  /** In-flight runner turn, used to distinguish active work from a reusable terminal result. */
  private activeTurn?: Promise<void>;
  /** Most recent terminal event, returned immediately when callers wait after a turn has settled. */
  private lastTerminal?: TurnTerminalEvent;
  /** Scheduled wake for sleeping poll states; cancelled when user input or interrupt arrives. */
  private wakeTimer?: ReturnType<typeof setTimeout>;
  /** Restores a prompt/answer turn back to sleep when the underlying state machine is still polling. */
  private restoreSleepAfterTurn?: boolean;
  /** Whether this session should hydrate `state.json` on first use. New sessions start empty. */
  private readonly resumeFromStorage: boolean;
  /** Pending callers of `waitForTerminal`, resolved together when the next terminal event arrives. */
  private readonly terminalWaiters: Array<(terminal: TurnTerminalEvent) => void> = [];

  constructor(
    readonly config: TurnRunnerConfig,
    options: SessionOptions,
  ) {
    this.id = options.id;
    this.state = options.initialState;
    this.resumeFromStorage = options.resumeFromStorage ?? Boolean(options.id);
    this.runner = options.runner ?? new TurnRunner(config);
    this.sessionPath = options.sessionPath;
    this.unsubscribeRunner = this.runner.subscribe((event) => void this.handleTurnEvent(event));
  }

  subscribe(handler: SessionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  async start(input: SessionStartInput): Promise<void> {
    if (!this.state && this.resumeFromStorage) {
      this.state = await this.readStoredState();
    }
    const command: TurnCommand = this.state
      ? {
          type: "prompt",
          state: this.state,
          message: input.prompt,
          behavior: "follow_up",
          ...(input.options ? { options: input.options } : {}),
        }
      : {
          type: "start",
          mode: input.mode ?? this.config.mode,
          prompt: input.prompt,
          ...(input.options ? { options: input.options } : {}),
        };
    this.dispatchTurn(command);
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnPoll(state);
    const command: TurnCommand = {
      type: "prompt",
      state,
      message: input.message,
      behavior: input.behavior ?? "follow_up",
      ...(input.options ? { options: input.options } : {}),
    };
    this.dispatchTurn(command);
  }

  async answer(input: SessionAnswerInput): Promise<void> {
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnPoll(state);
    const command: TurnAnswerCommand = {
      type: "answer",
      state,
      questions: input.questions,
      answers: input.answers,
      behavior: input.behavior ?? "follow_up",
      ...(input.options ? { options: input.options } : {}),
    };
    this.dispatchTurn(command);
  }

  async interrupt(): Promise<void> {
    const state = await this.requireState();
    this.cancelWake();
    this.runner.interrupt({ type: "interrupt", state });
  }

  editFollowUpQueue(input: SessionEditFollowUpQueueInput): void {
    this.runner.editFollowUpQueue({
      type: "edit_follow_up_queue",
      prompts: input.prompts,
    });
  }

  async waitForTerminal(): Promise<TurnTerminalEvent> {
    if (this.lastTerminal && !this.activeTurn) {
      return this.lastTerminal;
    }
    return new Promise((resolve) => {
      this.terminalWaiters.push(resolve);
    });
  }

  isTurnActive(): boolean {
    return Boolean(this.activeTurn);
  }

  /** Latest known turn state snapshot, including agent message history. */
  getState(): TurnState | undefined {
    return this.state;
  }

  /** Force-load persisted state for resumed sessions before any command runs. */
  async hydrate(): Promise<void> {
    if (!this.state && this.resumeFromStorage) {
      this.state = await this.readStoredState();
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribeRunner();
    this.cancelWake();
    await this.runner.dispose();
  }

  private dispatchTurn(command: TurnCommand): void {
    this.lastTerminal = undefined;
    const activeTurn = this.runner
      .turn(command)
      .then(() => undefined)
      .catch((error) => {
        this.emit({
          type: "system",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.activeTurn === activeTurn) {
          this.activeTurn = undefined;
        }
      });
    this.activeTurn = activeTurn;
  }

  private async handleTurnEvent(event: TurnEvent): Promise<void> {
    let emitted = event;
    if (isTerminalEvent(event)) {
      emitted = this.normalizeTerminalEvent(event);
      this.state = emitted.state;
      this.lastTerminal = emitted;
      await this.writeStoredState(emitted.state);
      if (emitted.type === "sleep") {
        this.scheduleWake(emitted);
      }
      for (const resolve of this.terminalWaiters.splice(0)) {
        resolve(emitted);
      }
    } else if (event.type === "session_started") {
      this.state = event.state;
    }
    this.emit(emitted);
  }

  private normalizeTerminalEvent(event: TurnTerminalEvent): TurnTerminalEvent {
    if (
      this.restoreSleepAfterTurn &&
      event.type === "complete" &&
      this.isWaitingOnPoll(event.state)
    ) {
      this.restoreSleepAfterTurn = false;
      if (event.status === "failed") {
        this.emit({
          type: "system",
          level: "error",
          message: event.error ?? event.result ?? "Prompt failed while waiting on poll.",
        });
      }
      const state = this.currentPollState(event.state);
      return {
        type: "sleep",
        wakeAt: Date.now() + (state?.intervalMs ?? 0),
        state: { ...event.state, status: "sleeping" },
      };
    }
    this.restoreSleepAfterTurn = false;
    return event;
  }

  private emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private scheduleWake(terminal: Extract<TurnTerminalEvent, { type: "sleep" }>): void {
    this.cancelWake();
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = undefined;
        if (!this.state || this.state.status !== "sleeping") return;
        this.dispatchTurn({ type: "wake", state: this.state });
      },
      Math.max(0, terminal.wakeAt - Date.now()),
    );
  }

  private cancelWake(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  private async requireState(): Promise<TurnState> {
    if (!this.state && this.resumeFromStorage) {
      this.state = await this.readStoredState();
    }
    if (!this.state) {
      throw new Error(`Unknown session: ${this.id}`);
    }
    return this.state;
  }

  private isWaitingOnPoll(state: TurnState | undefined): boolean {
    return Boolean(this.currentPollState(state) && !state?.stateMachine?.terminal);
  }

  private currentPollState(state: TurnState | undefined): StateMachinePollState | undefined {
    const stateMachine = state?.stateMachine;
    const currentState = stateMachine?.currentState;
    if (!stateMachine || !currentState) return undefined;
    const definitionState = stateMachine.definition.states.find(
      (item) => item.name === currentState,
    );
    return definitionState?.kind === "poll" ? definitionState : undefined;
  }

  private async readStoredState(): Promise<TurnState | undefined> {
    try {
      const content = await readFile(this.sessionFilePath(), "utf-8");
      const stored = JSON.parse(content) as { state?: TurnState; session?: TurnState };
      return stored.state ?? stored.session;
    } catch (error) {
      if (isEnoent(error) || String(error).includes(this.sessionFilePath())) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeStoredState(state: TurnState): Promise<void> {
    await writeFile(
      this.sessionFilePath(),
      `${JSON.stringify({ sessionId: this.id, updatedAt: Date.now(), state }, null, 2)}\n`,
      "utf-8",
    );
  }

  private sessionFilePath(): string {
    return join(this.sessionPath, "state.json");
  }
}

function isTerminalEvent(event: TurnEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function isEnoent(error: unknown): boolean {
  return String(error).includes("ENOENT");
}
