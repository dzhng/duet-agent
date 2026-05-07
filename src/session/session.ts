import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TurnRunner, type TurnEventHandler } from "../turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { SkillCollision } from "../turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptBehavior,
  TurnQuestion,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
} from "../types/protocol.js";
import type { StateMachinePollState } from "../types/state-machine.js";

export interface SessionStartInput {
  /** Routing mode for subsequent prompts. Omit to use the session's configured default. */
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
  start(command: TurnStartCommand): Promise<TurnState>;
  turn(command: TurnCommand): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void;
  subscribe(handler: TurnEventHandler): () => void;
  getSkills(): Promise<readonly Skill[]>;
  getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]>;
  getSkillCollisions(): Promise<readonly SkillCollision[]>;
  /** Latest runner-owned state, kept fresh mid-turn for shutdown flushes. */
  getState(): TurnState | undefined;
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
  /**
   * Initial state passed at construction time, consumed once on `start()` and
   * cleared. After start, `runner.getState()` is the single source of truth;
   * the session no longer caches state.
   */
  private initialState?: TurnState;
  /** In-flight runner turn, used to distinguish active work from a reusable terminal result. */
  private activeTurn?: Promise<void>;
  /** In-flight runner setup, awaited before any turn dispatches so turn_started lands first. */
  private startPromise?: Promise<void>;
  /** Tracks whether `start()` has already issued setup so repeat calls stay idempotent. */
  private hasStarted = false;
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
    this.initialState = options.initialState;
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

  /**
   * Initialize the session before any turn runs. Calls the runner's setup
   * step once so the caller can render skills and agent files immediately on
   * launch, before the user types a prompt.
   *
   * Repeat calls are no-ops; resumed sessions reuse the persisted state.
   */
  async start(input: SessionStartInput = {}): Promise<void> {
    if (this.hasStarted) {
      await this.startPromise;
      return;
    }
    this.hasStarted = true;
    let resumed = this.initialState;
    if (!resumed && this.resumeFromStorage) {
      resumed = await this.readStoredState();
    }
    this.initialState = undefined;
    const command: TurnStartCommand = {
      type: "start",
      ...((input.mode ?? this.config.mode) ? { mode: input.mode ?? this.config.mode } : {}),
      ...(resumed ? { state: resumed } : {}),
      ...(input.options ? { options: input.options } : {}),
    };
    this.startPromise = this.runner.start(command).then(() => undefined);
    await this.startPromise;
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    await this.ensureStarted();
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnPoll(state);
    const command: TurnCommand = {
      type: "prompt",
      message: input.message,
      behavior: input.behavior ?? "follow_up",
      ...(input.options ? { options: input.options } : {}),
    };
    this.dispatchTurn(command);
  }

  async answer(input: SessionAnswerInput): Promise<void> {
    await this.ensureStarted();
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnPoll(state);
    const command: TurnAnswerCommand = {
      type: "answer",
      questions: input.questions,
      answers: input.answers,
      behavior: input.behavior ?? "follow_up",
      ...(input.options ? { options: input.options } : {}),
    };
    this.dispatchTurn(command);
  }

  async interrupt(): Promise<void> {
    await this.ensureStarted();
    this.cancelWake();
    this.runner.interrupt({ type: "interrupt" });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.hasStarted) {
      await this.start();
      return;
    }
    await this.startPromise;
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

  /**
   * Latest turn state snapshot, sourced from the runner. Always returns the
   * live snapshot when the runner has been started; otherwise returns the
   * pre-start initial state if one was provided to the constructor.
   */
  getState(): TurnState | undefined {
    return this.runner.getState() ?? this.initialState;
  }

  /**
   * Persist the current state to disk. Call this before process exit so
   * mid-turn progress (in-flight agent messages, queued follow-ups, todos
   * touched but not yet committed via terminal) survives the shutdown.
   * No-op when no state exists yet.
   */
  async flush(): Promise<void> {
    const state = this.getState();
    if (!state) return;
    await this.writeStoredState(state);
  }

  /**
   * Skills discovered for this session. Available after `start()` resolves;
   * loading happens lazily on first call otherwise.
   */
  getSkills(): Promise<readonly Skill[]> {
    return this.runner.getSkills();
  }

  /** System-prompt files (AGENTS.md by default) that resolved on disk. */
  getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    return this.runner.getResolvedAgentFiles();
  }

  /** Skill name collisions where one definition shadowed another during discovery. */
  getSkillCollisions(): Promise<readonly SkillCollision[]> {
    return this.runner.getSkillCollisions();
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
      this.lastTerminal = emitted;
      await this.writeStoredState(emitted.state);
      if (emitted.type === "sleep") {
        this.scheduleWake(emitted);
      }
      for (const resolve of this.terminalWaiters.splice(0)) {
        resolve(emitted);
      }
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
        const state = this.runner.getState();
        if (!state || state.status !== "sleeping") return;
        this.dispatchTurn({ type: "wake" });
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
    const state = this.runner.getState();
    if (!state) {
      throw new Error(`Unknown session: ${this.id}`);
    }
    return state;
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
