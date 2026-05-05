import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { TurnRunner, type TurnEventHandler } from "../turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnAnswerCommand,
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

export type SessionEventHandler = (event: TurnEvent) => void;

export interface SessionTurnRunner {
  turn(command: TurnCommand): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  subscribe(handler: TurnEventHandler): () => void;
  dispose(): Promise<void>;
}

export interface SessionOptions {
  id?: string;
  runner?: SessionTurnRunner;
  initialState?: TurnState;
  resumeFromStorage?: boolean;
  sessionStoragePath?: string;
}

export class Session {
  readonly id: string;
  private readonly runner: SessionTurnRunner;
  private readonly sessionStoragePath: string;
  private readonly eventHandlers = new Set<SessionEventHandler>();
  private readonly unsubscribeRunner: () => void;
  private state?: TurnState;
  private activeTurn?: Promise<void>;
  private lastTerminal?: TurnTerminalEvent;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private restoreSleepAfterTurn?: boolean;
  private readonly resumeFromStorage: boolean;
  private readonly terminalWaiters: Array<(terminal: TurnTerminalEvent) => void> = [];

  constructor(
    readonly config: TurnRunnerConfig,
    options: SessionOptions = {},
  ) {
    this.id = options.id ?? createSessionId();
    this.state = options.initialState;
    this.resumeFromStorage = options.resumeFromStorage ?? Boolean(options.id);
    this.runner = options.runner ?? new TurnRunner(config);
    this.sessionStoragePath =
      options.sessionStoragePath ?? join(config.cwd ?? process.cwd(), ".agents", "sessions");
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
          behavior: "steer",
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
    this.dispatchTurn({
      type: "prompt",
      state,
      message: input.message,
      behavior: input.behavior ?? "steer",
      ...(input.options ? { options: input.options } : {}),
    });
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

  async waitForTerminal(): Promise<TurnTerminalEvent> {
    if (this.lastTerminal && !this.activeTurn) {
      return this.lastTerminal;
    }
    return new Promise((resolve) => {
      this.terminalWaiters.push(resolve);
    });
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
          type: "log",
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
    try {
      await mkdir(this.sessionStoragePath, { recursive: true });
      await writeFile(
        this.sessionFilePath(),
        `${JSON.stringify({ sessionId: this.id, updatedAt: Date.now(), state }, null, 2)}\n`,
        "utf-8",
      );
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  private sessionFilePath(): string {
    return join(this.sessionStoragePath, `${sanitizeSessionId(this.id)}.json`);
  }
}

export interface SessionManagerCreateInput extends SessionStartInput {
  sessionId?: string;
}

export interface SessionManagerOptions {
  sessionStoragePath?: string;
  createRunner?: (sessionId: string) => SessionTurnRunner;
}

export type SessionManagerEvent = {
  sessionId: string;
  event: TurnEvent;
};

export type SessionManagerEventHandler = (event: SessionManagerEvent) => void;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly eventHandlers = new Set<SessionManagerEventHandler>();
  private readonly sessionStoragePath: string;

  constructor(
    readonly config: TurnRunnerConfig,
    private readonly options: SessionManagerOptions = {},
  ) {
    this.sessionStoragePath =
      options.sessionStoragePath ?? join(config.cwd ?? process.cwd(), ".agents", "sessions");
  }

  subscribe(handler: SessionManagerEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  create(input: SessionManagerCreateInput): Session {
    const session = this.createSession(input.sessionId, false);
    this.sessions.set(session.id, session);
    void session.start(input);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = this.createSession(sessionId, true);
    this.sessions.set(sessionId, session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.dispose();
    }
    this.sessions.clear();
  }

  private createSession(sessionId: string | undefined, resumeFromStorage: boolean): Session {
    const id = sessionId ?? createSessionId();
    const session = new Session(this.config, {
      id,
      runner: this.options.createRunner?.(id),
      resumeFromStorage,
      sessionStoragePath: this.sessionStoragePath,
    });
    session.subscribe((event) => {
      this.emit({ sessionId: session.id, event });
    });
    return session;
  }

  private emit(event: SessionManagerEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}

function createSessionId(): string {
  return `session_${nanoid(12)}`;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
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
