import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TurnRunner, type TurnEventHandler } from "../turn-runner/turn-runner.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "../turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptBehavior,
  TurnPromptImage,
  TurnQuestion,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
} from "../types/protocol.js";
import type { StateMachinePollState, StateMachineTimerState } from "../types/state-machine.js";

/**
 * How often `scheduleWake` checks the wall clock against `wakeAt`. Polling — instead of relying
 * on a single long `setTimeout` — keeps wakes correct after macOS / Windows / container sleep,
 * because Node and Bun timers run off a monotonic clock that pauses with the process.
 */
const WAKE_POLL_INTERVAL_MS = 30_000;

export interface SessionStartInput {
  /** Routing mode for subsequent prompts. Omit to use the session's configured default. */
  mode?: TurnMode;
  options?: TurnOptions;
  /** Remote MCP servers connected once before the first turn runs. */
  mcpServers?: TurnStartCommand["mcpServers"];
}

export interface SessionPromptInput {
  message: string;
  behavior?: TurnPromptBehavior;
  /**
   * Optional image attachments forwarded to the runner alongside the prompt
   * text. Each entry is a base64-encoded image plus its MIME type.
   */
  images?: TurnPromptImage[];
}

export interface SessionAnswerInput {
  questions: TurnQuestion[];
  answers: Record<string, string>;
  behavior?: TurnPromptBehavior;
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
  getState(): TurnState | undefined;
  getSkills(): Promise<readonly Skill[]>;
  getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]>;
  getSkillCollisions(): Promise<readonly SkillCollision[]>;
  dispose(): Promise<void>;
}

export interface SessionOptions {
  id: string;
  /** Concrete directory owned by this session. The manager creates it before construction. */
  sessionPath: string;
  runner?: SessionTurnRunner;
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
  /** In-flight runner turn, used to distinguish active work from a reusable terminal result. */
  private activeTurn?: Promise<void>;
  /** In-flight runner setup, awaited before any turn dispatches so turn_started lands first. */
  private startPromise?: Promise<void>;
  /** Most recent terminal event, returned immediately when callers wait after a turn has settled. */
  private lastTerminal?: TurnTerminalEvent;
  /**
   * Polling interval that fires the wake when wall-clock `Date.now()` reaches `wakeAt`. Cleared
   * when user input or an interrupt arrives. We poll instead of using a single `setTimeout` so a
   * laptop that sleeps through the deadline still fires shortly after wake: Node/Bun timers are
   * driven by a monotonic clock that pauses on macOS sleep, so a long `setTimeout` would drift by
   * the duration of the sleep. Polling against `Date.now()` is sleep-proof.
   */
  private wakeTimer?: ReturnType<typeof setInterval>;
  /** Optional fast-path timer used when the deadline is closer than the poll interval. */
  private wakeFastPath?: ReturnType<typeof setTimeout>;
  /** Restores a prompt/answer turn back to sleep when the state machine is still waiting. */
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
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    const state = this.resumeFromStorage ? await this.readStoredState() : undefined;
    const command: TurnStartCommand = {
      type: "start",
      ...((input.mode ?? this.config.mode) ? { mode: input.mode ?? this.config.mode } : {}),
      ...(state ? { state } : {}),
      ...this.startOptions(input.options),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    };
    this.startPromise = this.runner.start(command).then(() => undefined);
    await this.startPromise;
    if (state?.status === "sleeping") {
      await this.replaySleepFromResumedState(state);
    }
  }

  /**
   * Resumed sleeping sessions never re-run the original `sleep` terminal event,
   * so the polling wake timer and the TUI sleeping banner would stay dormant.
   * Synthesize a `sleep` event from the persisted state and feed it through the
   * normal terminal-event path so `scheduleWake` arms the timer and subscribers
   * receive the banner.
   */
  private async replaySleepFromResumedState(state: TurnState): Promise<void> {
    const scheduled = this.currentScheduledState(state);
    const progress = scheduled ? state.stateMachine?.progress?.states[scheduled.name] : undefined;
    const wakeAt =
      progress?.nextWakeAt ??
      (scheduled?.kind === "poll"
        ? Date.now() + scheduled.intervalMs
        : (scheduled?.wakeAt ?? Date.now()));
    await this.handleTurnEvent({ type: "sleep", wakeAt, state });
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    await this.ensureStarted();
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnScheduledState(state);
    const command: TurnCommand = {
      type: "prompt",
      message: input.message,
      behavior: input.behavior ?? "follow_up",
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    };
    this.dispatchTurn(command);
  }

  async answer(input: SessionAnswerInput): Promise<void> {
    await this.ensureStarted();
    const state = await this.requireState();
    this.cancelWake();
    const wasSleeping = state.status === "sleeping";
    this.restoreSleepAfterTurn = wasSleeping && this.isWaitingOnScheduledState(state);
    const command: TurnAnswerCommand = {
      type: "answer",
      questions: input.questions,
      answers: input.answers,
      behavior: input.behavior ?? "follow_up",
    };
    this.dispatchTurn(command);
  }

  async interrupt(): Promise<void> {
    await this.ensureStarted();
    this.cancelWake();
    this.runner.interrupt({ type: "interrupt" });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
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
   * Most recent terminal event emitted by the runner, or `undefined` if no
   * turn has settled yet. Subscribers attached after `hydrate()` / `start()`
   * (e.g. a deferred TUI) can use this to recover state — notably the sleep
   * banner — that was emitted before they began listening.
   */
  getLastTerminal(): TurnTerminalEvent | undefined {
    if (this.activeTurn) return undefined;
    return this.lastTerminal;
  }

  /** Current runner-owned turn state snapshot, including agent message history. */
  getState(): TurnState | undefined {
    return this.runner.getState();
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

  /** Start this session from persisted state before dispatching a user command. */
  async hydrate(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (!this.resumeFromStorage) return;
    const state = await this.readStoredState();
    if (!state) return;
    this.startPromise = this.runner
      .start({ type: "start", state, ...this.startOptions() })
      .then(() => undefined);
    await this.startPromise;
    if (state.status === "sleeping") {
      await this.replaySleepFromResumedState(state);
    }
  }

  async dispose(): Promise<void> {
    await this.persistLatestState();
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
      this.isWaitingOnScheduledState(event.state)
    ) {
      this.restoreSleepAfterTurn = false;
      if (event.status === "failed") {
        this.emit({
          type: "system",
          level: "error",
          message: event.error ?? event.result ?? "Prompt failed while waiting.",
        });
      }
      const state = this.currentScheduledState(event.state);
      const progress = state ? event.state.stateMachine?.progress?.states[state.name] : undefined;
      const wakeAt =
        progress?.nextWakeAt ??
        (state?.kind === "poll" ? Date.now() + state.intervalMs : (state?.wakeAt ?? Date.now()));
      return {
        type: "sleep",
        wakeAt,
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
    const fire = (): void => {
      if (Date.now() < terminal.wakeAt) return;
      this.cancelWake();
      const state = this.runner.getState();
      if (!state || state.status !== "sleeping") return;
      this.dispatchTurn({ type: "wake" });
    };
    // Poll every 30s so a sleeping laptop still wakes the turn shortly after the lid reopens.
    // Jitter is bounded by the poll interval and is acceptable given the 15-minute minimum
    // wakeAt enforced upstream.
    this.wakeTimer = setInterval(fire, WAKE_POLL_INTERVAL_MS);
    // Fast-path for deadlines closer than the poll interval so short waits stay tight.
    const remaining = terminal.wakeAt - Date.now();
    if (remaining < WAKE_POLL_INTERVAL_MS) {
      this.wakeFastPath = setTimeout(fire, Math.max(0, remaining));
    }
  }

  private cancelWake(): void {
    if (this.wakeTimer) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    if (this.wakeFastPath) {
      clearTimeout(this.wakeFastPath);
      this.wakeFastPath = undefined;
    }
  }

  private async requireState(): Promise<TurnState> {
    await this.ensureStarted();
    const state = this.runner.getState();
    if (!state) {
      throw new Error(`Unknown session: ${this.id}`);
    }
    return state;
  }

  private async persistLatestState(): Promise<void> {
    const state = this.runner.getState();
    if (!state) return;
    await this.writeStoredState(state);
  }

  private startOptions(options?: TurnOptions): { options?: TurnOptions } {
    // CLI/TUI config is the current session contract. On resume it should
    // override persisted options so flags like --model take effect immediately.
    const effective: TurnOptions = {
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.memoryModel ? { memoryModel: this.config.memoryModel } : {}),
      ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
      ...options,
    };
    return Object.keys(effective).length > 0 ? { options: effective } : {};
  }

  private isWaitingOnScheduledState(state: TurnState | undefined): boolean {
    return Boolean(this.currentScheduledState(state) && !state?.stateMachine?.terminal);
  }

  private currentScheduledState(
    state: TurnState | undefined,
  ): StateMachinePollState | StateMachineTimerState | undefined {
    const stateMachine = state?.stateMachine;
    const currentState = stateMachine?.currentState;
    if (!stateMachine || !currentState) return undefined;
    const definitionState = stateMachine.definition.states.find(
      (item) => item.name === currentState,
    );
    return definitionState?.kind === "poll" || definitionState?.kind === "timer"
      ? definitionState
      : undefined;
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
