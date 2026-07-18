import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Session, type SessionTurnRunner } from "../src/session/session.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import {
  DEFAULT_MEMORY_DB_PATH,
  DEFAULT_SESSION_STORAGE_DIR,
  SessionManager,
} from "../src/session/session-manager.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "../src/turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnCompactCommand,
  TurnEvent,
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
  TurnUsageEvent,
  TurnCommand,
} from "../src/types/protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { waitFor } from "./helpers/async.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class FakeTurnRunner implements SessionTurnRunner {
  readonly startCommands: TurnStartCommand[] = [];
  readonly commands: TurnCommand[] = [];
  readonly interrupts: TurnInterruptCommand[] = [];
  readonly compacts: TurnCompactCommand[] = [];
  readonly followUpQueueEdits: TurnEditFollowUpQueueCommand[] = [];
  readonly handlers = new Set<(event: TurnEvent) => void>();
  state = turnState;
  skills: readonly Skill[] = [];
  skillInstructions = new Map<string, string>();
  disposed = false;
  terminals: TurnTerminalEvent[];
  pendingTurns: Array<{
    command: TurnCommand;
    resolve: (terminal: TurnTerminalEvent) => void;
  }> = [];

  constructor(terminals: TurnTerminalEvent[]) {
    this.terminals = [...terminals];
  }

  async start(command: TurnStartCommand): Promise<TurnState> {
    this.startCommands.push(command);
    this.emit({ type: "turn_started", state: turnState });
    return turnState;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.commands.push(command);
    if (command.type === "wake" && this.terminals.length === 0) {
      const terminal: TurnTerminalEvent = {
        type: "complete",
        status: "completed",
        result: "Nothing to wake.",
        state: this.state,
      };
      this.emit(terminal);
      return terminal;
    }
    return new Promise((resolve) => {
      this.pendingTurns.push({ command, resolve });
      if (this.terminals.length > 0) {
        this.resolveNext();
      }
    });
  }

  interrupt(command: TurnInterruptCommand): void {
    this.interrupts.push(command);
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {
        ...this.state,
        status: "interrupted",
        agent: { ...this.state.agent, status: "cancelled" },
        stateMachine: this.state.stateMachine
          ? {
              ...this.state.stateMachine,
              terminal: { state: "interrupted", status: "cancelled" },
              history: [
                ...this.state.stateMachine.history,
                {
                  type: "state_machine_completed",
                  timestamp: Date.now(),
                  terminal: { state: "interrupted", status: "cancelled" },
                },
              ],
            }
          : undefined,
      },
    };
    this.state = terminal.state;
    this.terminals.push(terminal);
    this.emit(terminal);
    this.resolveNext();
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.followUpQueueEdits.push(command);
    this.emit({ type: "follow_up_queue", followUpQueue: command.prompts });
  }

  compact(command: TurnCompactCommand): void {
    this.compacts.push(command);
  }

  getState(): TurnState | undefined {
    return this.state;
  }

  subscribe(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getSkills(): Promise<readonly Skill[]> {
    return this.skills;
  }

  async reloadSkills(): Promise<readonly Skill[]> {
    return this.skills;
  }

  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    return [];
  }

  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    return [];
  }

  getSkillInstructions(skillId: string): string {
    return this.skillInstructions.get(skillId) ?? "";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  resolveNext(terminal = this.terminals.shift()): void {
    const pending = this.pendingTurns.shift();
    if (!pending || !terminal) return;
    this.state = terminal.state;
    this.emit(terminal);
    pending.resolve(terminal);
  }

  emit(event: TurnEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

const turnState = createStateMachineState("draft");
let tempDirs: string[] = [];

async function createSession(runner: FakeTurnRunner): Promise<Session> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
  tempDirs.push(tempDir);
  return new Session(
    { model: "anthropic:claude-opus-4-7" },
    { id: "session_test", runner: runner, sessionPath: tempDir },
  );
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function buildUsageEvent(costTotal: number): TurnUsageEvent {
  const usage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
  return {
    type: "usage",
    turnUsage: usage,
    usageByModel: [{ model: "test-model", usage }],
    lastMessageUsage: usage,
    effectiveContextWindow: 200_000,
    contextWindowUsage: { systemPrompt: 10, messages: 90, localMemory: 20, globalMemory: 30 },
  };
}

function complete(result = "done"): TurnTerminalEvent {
  return {
    type: "complete",
    status: "completed",
    result,
    state: turnState,
  };
}

async function writeStoredState(sessionPath: string, state: TurnState): Promise<void> {
  await writeFile(
    join(sessionPath, "state.json"),
    `${JSON.stringify({ sessionId: "resumed-options", updatedAt: Date.now(), state }, null, 2)}\n`,
    "utf-8",
  );
}

describe("Session", () => {
  test("plumbs sessionId into the runner config so memory writes can be tagged", async () => {
    // Real TurnRunner construction path — the FakeTurnRunner shortcut
    // skips the config copy this test is verifying.
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const session = new Session(
      { model: "anthropic:claude-opus-4-7", memoryDbPath: false },
      { id: "session_under_test", sessionPath: tempDir },
    );
    const runner = (session as unknown as { runner: TurnRunner }).runner;
    expect(runner.config.sessionId).toBe("session_under_test");
    await session.dispose();
  });

  testIfDocker("starts a session without waiting for the runner terminal event", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "hello" });
    await session.waitForTerminal();

    expect(session.id).toStartWith("session_");
    expect(runner.commands).toEqual([{ type: "prompt", message: "hello", behavior: "follow_up" }]);
  });

  testIfDocker("compact() forwards to the runner and persists the new wire horizon", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "compact-session");
    await mkdir(sessionPath, { recursive: true });
    const runner = new FakeTurnRunner([]);
    const session = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "compact-session", runner, sessionPath },
    );
    await session.start();
    // Simulate the runner advancing its horizon during compaction. The
    // session reads `runner.getState()` when it persists, so this is
    // the cleanest end-to-end proxy for "the runner ran compaction
    // and the persisted snapshot must carry the new horizon forward
    // for the next resume" without booting a real TurnRunner.
    const compactedState: TurnState = {
      ...turnState,
      wireGuardHorizon: { evictionHorizon: 4242 },
    };
    runner.state = compactedState;

    await session.compact();

    expect(runner.compacts).toEqual([{ type: "compact" }]);
    const content = await readFile(join(sessionPath, "state.json"), "utf-8");
    const stored = JSON.parse(content);
    // Resume must see the same wire-shaping object — otherwise a
    // session compacted before the user exits the TUI would lose the
    // trim on next launch. Persisting the whole object (not just the
    // horizon timestamp) is what lets future wire-shaping fields be
    // added without touching the persistence path.
    expect(stored.state.wireGuardHorizon).toEqual({ evictionHorizon: 4242 });
  });

  testIfDocker("forwards follow-up queue edits to the runner", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);
    const events: TurnEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.editFollowUpQueue({ prompts: [{ message: "after this" }] });

    expect(runner.followUpQueueEdits).toEqual([
      { type: "edit_follow_up_queue", prompts: [{ message: "after this" }] },
    ]);
    expect(events).toContainEqual({
      type: "follow_up_queue",
      followUpQueue: [{ message: "after this" }],
    });
  });

  testIfDocker("wraps runner events with the session id", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);
    const events: TurnEvent[] = [];

    const unsubscribe = session.subscribe((event) => events.push(event));
    await session.start();
    await session.prompt({ message: "hello" });
    await session.waitForTerminal();
    unsubscribe();
    runner.emit({ type: "system", level: "info", message: "ignored" });

    expect(events[0]).toMatchObject({ type: "turn_started" });
    expect(events.at(-1)).toMatchObject({ type: "complete" });
  });

  testIfDocker("schedules wake after sleep without blocking command submission", async () => {
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    const runner = new FakeTurnRunner([
      { type: "sleep", wakeAt: Date.now(), state: sleeping },
      complete("awake"),
    ]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "poll" });
    await waitFor(() => runner.commands.length >= 2);

    expect(runner.commands).toEqual([
      { type: "prompt", message: "poll", behavior: "follow_up" },
      { type: "wake" },
    ]);
  });

  testIfDocker("persists terminal state snapshots by session id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const runner = new FakeTurnRunner([complete("stored")]);
    await mkdir(join(tempDir, "existing-session"), { recursive: true });
    const session = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "existing-session", runner: runner, sessionPath: join(tempDir, "existing-session") },
    );

    await session.start();
    await session.prompt({ message: "remember me" });
    await session.waitForTerminal();
    const content = await readFile(join(tempDir, "existing-session", "state.json"), "utf-8");
    const stored = JSON.parse(content);

    expect(stored.sessionId).toBe("existing-session");
    expect(stored.state.agent.messages).toEqual(turnState.agent.messages);
  });

  testIfDocker("persists latest runner state during dispose without a terminal event", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const runner = new FakeTurnRunner([]);
    const latestState: TurnState = {
      ...turnState,
      todos: [{ id: "persist", content: "Persist latest state", status: "in_progress" }],
      followUpQueue: [{ message: "keep this follow-up" }],
    };
    runner.state = latestState;
    await mkdir(join(tempDir, "dispose-session"), { recursive: true });
    const session = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "dispose-session", runner, sessionPath: join(tempDir, "dispose-session") },
    );

    await session.start();
    await session.dispose();
    const content = await readFile(join(tempDir, "dispose-session", "state.json"), "utf-8");
    const stored = JSON.parse(content);

    expect(stored.state.todos).toEqual(latestState.todos);
    expect(stored.state.followUpQueue).toEqual([{ message: "keep this follow-up" }]);
  });

  testIfDocker("reads current state from the runner", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);
    const latestState: TurnState = { ...turnState, status: "sleeping" };

    await session.start();
    runner.state = latestState;

    expect(session.getState()).toEqual(latestState);
  });

  testIfDocker("disposes runner resources", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);

    await session.dispose();

    expect(runner.disposed).toBe(true);
  });

  testIfDocker("continues stored sessions with prompt commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const firstTurnRunner = new FakeTurnRunner([complete("first")]);
    await mkdir(join(tempDir, "continuable"), { recursive: true });
    const first = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "continuable", runner: firstTurnRunner, sessionPath: join(tempDir, "continuable") },
    );
    await first.start();
    await first.prompt({ message: "start" });
    await first.waitForTerminal();
    const secondTurnRunner = new FakeTurnRunner([complete("second")]);

    const second = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "continuable", runner: secondTurnRunner, sessionPath: join(tempDir, "continuable") },
    );
    await second.start();
    await second.prompt({ message: "continue" });
    await second.waitForTerminal();

    expect(secondTurnRunner.commands).toEqual([
      { type: "prompt", message: "continue", behavior: "follow_up" },
    ]);
  });

  testIfDocker("resumed sessions start with current config options", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "resumed-options");
    await mkdir(sessionPath, { recursive: true });
    await writeStoredState(sessionPath, {
      ...turnState,
      options: {
        model: "anthropic:old-persisted-model",
        memoryModel: "anthropic:old-memory-model",
        thinkingLevel: "medium",
      },
    });
    const runner = new FakeTurnRunner([complete("resumed")]);
    const session = new Session(
      {
        model: "anthropic:new-config-model",
        memoryModel: "anthropic:new-memory-model",
        thinkingLevel: "high",
      },
      {
        id: "resumed-options",
        runner,
        sessionPath,
        resumeFromStorage: true,
      },
    );

    await session.start();

    expect(runner.startCommands).toHaveLength(1);
    expect(runner.startCommands[0]).toMatchObject({
      type: "start",
      options: {
        model: "anthropic:new-config-model",
        memoryModel: "anthropic:new-memory-model",
        thinkingLevel: "high",
      },
    });
    expect(runner.startCommands[0].state?.options).toMatchObject({
      model: "anthropic:old-persisted-model",
      memoryModel: "anthropic:old-memory-model",
      thinkingLevel: "medium",
    });
  });

  testIfDocker("restores lastUsage and sessionCostUsd from state.json on start", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "telemetry-resume");
    await mkdir(sessionPath, { recursive: true });

    const persistedUsageTokens = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };
    const persistedUsage = {
      turnUsage: persistedUsageTokens,
      usageByModel: [{ model: "test-model", usage: persistedUsageTokens }],
      lastMessageUsage: persistedUsageTokens,
      effectiveContextWindow: 200_000,
      contextWindowUsage: {
        systemPrompt: 10,
        messages: 70,
        localMemory: 30,
        globalMemory: 40,
      },
    };

    await writeFile(
      join(sessionPath, "state.json"),
      `${JSON.stringify(
        {
          sessionId: "telemetry-resume",
          updatedAt: Date.now(),
          state: turnState,
          lastUsage: persistedUsage,
          sessionCostUsd: 1.25,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const runner = new FakeTurnRunner([complete("ok")]);
    const session = new Session(
      { model: "anthropic:claude-opus-4-7" },
      { id: "telemetry-resume", runner, sessionPath, resumeFromStorage: true },
    );

    await session.start();

    expect(session.getLastUsage()).toEqual(persistedUsage);
    expect(session.getSessionCostUsd()).toBe(1.25);
  });

  testIfDocker("tracks in-flight turn cost mid-turn and commits it on terminal", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);
    await session.start();

    // Mid-turn usage events publish the running aggregate so the sidebar
    // ticks live, but only the terminal credits the cost to the persisted
    // session total.
    runner.emit(buildUsageEvent(0.05));
    expect(session.getSessionCostUsd()).toBeCloseTo(0.05, 6);
    runner.emit(buildUsageEvent(0.07));
    runner.emit(buildUsageEvent(0.1));
    expect(session.getSessionCostUsd()).toBeCloseTo(0.1, 6);

    runner.emit({
      type: "complete",
      status: "completed",
      result: "done",
      state: turnState,
      turnUsage: buildUsageEvent(0.1).turnUsage,
      lastMessageUsage: buildUsageEvent(0.1).lastMessageUsage,
      effectiveContextWindow: buildUsageEvent(0.1).effectiveContextWindow,
      contextWindowUsage: buildUsageEvent(0.1).contextWindowUsage,
    });
    expect(session.getSessionCostUsd()).toBeCloseTo(0.1, 6);

    // Second turn: the runner does not re-emit `turn_started` between
    // turn chains, but the terminal already cleared the in-flight tracker,
    // so a fresh per-turn aggregate of 0.04 lifts the displayed total to
    // 0.14 — even though that number is smaller than the prior turn's
    // high-water mark.
    runner.emit(buildUsageEvent(0.04));
    expect(session.getSessionCostUsd()).toBeCloseTo(0.14, 6);
    runner.emit({
      type: "complete",
      status: "completed",
      result: "done",
      state: turnState,
      turnUsage: buildUsageEvent(0.04).turnUsage,
      lastMessageUsage: buildUsageEvent(0.04).lastMessageUsage,
      effectiveContextWindow: buildUsageEvent(0.04).effectiveContextWindow,
      contextWindowUsage: buildUsageEvent(0.04).contextWindowUsage,
    });
    expect(session.getSessionCostUsd()).toBeCloseTo(0.14, 6);

    // Third turn establishes that each terminal credits its own per-turn
    // total exactly once and the in-flight tracker resets between turns.
    runner.emit(buildUsageEvent(0.01));
    expect(session.getSessionCostUsd()).toBeCloseTo(0.15, 6);
    runner.emit({
      type: "complete",
      status: "completed",
      result: "done",
      state: turnState,
      turnUsage: buildUsageEvent(0.01).turnUsage,
      lastMessageUsage: buildUsageEvent(0.01).lastMessageUsage,
      effectiveContextWindow: buildUsageEvent(0.01).effectiveContextWindow,
      contextWindowUsage: buildUsageEvent(0.01).contextWindowUsage,
    });
    expect(session.getSessionCostUsd()).toBeCloseTo(0.15, 6);

    await session.dispose();
  });

  testIfDocker("sends active prompts through turn runner", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "start" });
    await waitFor(() => runner.commands.length === 1);
    await session.prompt({ message: "steer now", behavior: "steer" });

    expect(runner.commands).toEqual([
      { type: "prompt", message: "start", behavior: "follow_up" },
      { type: "prompt", message: "steer now", behavior: "steer" },
    ]);
  });

  testIfDocker("sends follow-up prompts through turn runner while active", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "start" });
    await waitFor(() => runner.commands.length === 1);
    await session.prompt({ message: "queue later", behavior: "follow_up" });

    expect(runner.commands).toEqual([
      { type: "prompt", message: "start", behavior: "follow_up" },
      { type: "prompt", message: "queue later", behavior: "follow_up" },
    ]);
  });

  testIfDocker("routes answers with the latest live state", async () => {
    const waiting = { ...turnState, status: "waiting_for_human" as const };
    const runner = new FakeTurnRunner([{ type: "ask", questions: [], state: waiting }]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "question" });
    await session.waitForTerminal();
    await session.answer({
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { choice: ["A"] },
    });

    expect(runner.commands.at(-1)).toMatchObject({
      type: "answer",
      behavior: "follow_up",
    });
  });

  testIfDocker(
    "interrupts active state-machine work and persists the interrupted marker",
    async () => {
      const runner = new FakeTurnRunner([]);
      const session = await createSession(runner);

      await session.start();
      await session.prompt({ message: "start" });
      await waitFor(() => runner.commands.length === 1);
      await session.interrupt();
      const terminal = await session.waitForTerminal();

      expect(runner.interrupts).toHaveLength(1);
      expect(terminal.state.stateMachine?.terminal).toMatchObject({
        state: "interrupted",
        status: "cancelled",
      });
    },
  );

  testIfDocker("stale wake after interrupting sleeping state is a no-op", async () => {
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    const runner = new FakeTurnRunner([
      { type: "sleep", wakeAt: Date.now() + 60_000, state: sleeping },
    ]);
    const session = await createSession(runner);
    const events: TurnEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.start();
    await session.prompt({ message: "poll" });
    await session.waitForTerminal();
    await session.interrupt();
    await waitFor(() => events.some((event) => event.type === "interrupted"));
    const interrupted = events.find((event) => event.type === "interrupted");
    if (!interrupted || interrupted.type !== "interrupted") {
      throw new Error("Expected interrupted event");
    }
    const staleWake = await runner.turn({ type: "wake" });

    expect(staleWake).toMatchObject({
      type: "complete",
      status: "completed",
      result: "Nothing to wake.",
      state: { status: "interrupted" },
    });
  });

  testIfDocker(
    "returns sleeping sessions to sleep after user prompts while still waiting",
    async () => {
      const sleeping = {
        ...createStateMachineState("poll_email_reply"),
        status: "sleeping" as const,
      };
      const wakeAt = Date.now() + 60_000;
      const runner = new FakeTurnRunner([{ type: "sleep", wakeAt, state: sleeping }]);
      const session = await createSession(runner);

      await session.start();
      await session.prompt({ message: "poll" });
      await session.waitForTerminal();
      await session.prompt({ message: "anything new?" });
      runner.terminals.push({
        type: "sleep",
        wakeAt,
        state: sleeping,
      });
      runner.resolveNext();
      const terminal = await session.waitForTerminal();

      expect(terminal).toMatchObject({
        type: "sleep",
        state: { status: "sleeping", stateMachine: { currentState: "poll_email_reply" } },
      });
    },
  );

  testIfDocker("re-arms the same wake after a prompt during sleep", async () => {
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    const wakeAt = Date.now() + 60_000;
    const runner = new FakeTurnRunner([
      { type: "sleep", wakeAt, state: sleeping },
      { type: "sleep", wakeAt, state: sleeping },
    ]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "begin waiting" });
    await session.waitForTerminal();
    await session.prompt({ message: "anything new mid-sleep?" });
    const terminal = await session.waitForTerminal();

    expect(terminal).toMatchObject({ type: "sleep", wakeAt });
    expect(runner.commands.map((command) => command.type)).toEqual(["prompt", "prompt"]);
  });

  testIfDocker(
    "resumes sleeping sessions by replaying a sleep event and arming the wake timer",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "resumed-sleeping");
      await mkdir(sessionPath, { recursive: true });
      const wakeAt = Date.now() - 1_000;
      const sleepingState: TurnState = {
        ...createStateMachineState("poll_email_reply"),
        status: "sleeping",
        stateMachine: {
          ...createStateMachineState("poll_email_reply").stateMachine!,
          progress: {
            states: {
              poll_email_reply: { kind: "poll", runs: 1, sleeps: 1, nextWakeAt: wakeAt },
            },
          },
        },
      };
      await writeStoredState(sessionPath, sleepingState);
      const runner = new FakeTurnRunner([]);
      runner.state = sleepingState;
      const session = new Session(
        { model: "anthropic:claude-opus-4-7" },
        { id: "resumed-sleeping", runner, sessionPath, resumeFromStorage: true },
      );
      const events: TurnEvent[] = [];
      session.subscribe((event) => events.push(event));

      await session.hydrate();
      await session.start();
      await waitFor(() => runner.commands.some((command) => command.type === "wake"));

      const sleepEvents = events.filter((event) => event.type === "sleep");
      expect(sleepEvents).toHaveLength(1);
      expect(sleepEvents[0]).toMatchObject({
        type: "sleep",
        wakeAt,
        state: { status: "sleeping" },
      });
      expect(runner.commands).toEqual([{ type: "wake" }]);
    },
  );

  testIfDocker(
    "exposes the replayed sleep terminal to subscribers attached after hydrate",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "resumed-sleeping-late");
      await mkdir(sessionPath, { recursive: true });
      const wakeAt = Date.now() + 60_000;
      const sleepingState: TurnState = {
        ...createStateMachineState("poll_email_reply"),
        status: "sleeping",
        stateMachine: {
          ...createStateMachineState("poll_email_reply").stateMachine!,
          progress: {
            states: {
              poll_email_reply: { kind: "poll", runs: 1, sleeps: 0, nextWakeAt: wakeAt },
            },
          },
        },
      };
      await writeStoredState(sessionPath, sleepingState);
      const runner = new FakeTurnRunner([]);
      runner.state = sleepingState;
      const session = new Session(
        { model: "anthropic:claude-opus-4-7" },
        { id: "resumed-sleeping-late", runner, sessionPath, resumeFromStorage: true },
      );

      await session.hydrate();

      // Subscribers like the TUI attach after hydrate() runs. The replayed
      // sleep terminal must still be reachable so they can render the
      // "sleeping until …" banner on launch.
      const lateEvents: TurnEvent[] = [];
      session.subscribe((event) => lateEvents.push(event));

      const pending = session.getLastTerminal();
      expect(pending).toMatchObject({ type: "sleep", wakeAt });
      expect(lateEvents).toHaveLength(0);
    },
  );

  testIfDocker(
    "allows a complete turn to be followed by another prompt on the same session",
    async () => {
      const runner = new FakeTurnRunner([complete("first"), complete("second")]);
      const session = await createSession(runner);

      await session.start();
      await session.prompt({ message: "start" });
      await session.waitForTerminal();
      await session.prompt({ message: "next" });

      expect(runner.commands).toEqual([
        { type: "prompt", message: "start", behavior: "follow_up" },
        { type: "prompt", message: "next", behavior: "follow_up" },
      ]);
    },
  );
});

describe("SessionManager", () => {
  test("defaults session and memory storage to the home .duet directory", () => {
    expect(DEFAULT_SESSION_STORAGE_DIR).toBe(join(homedir(), ".duet", "sessions"));
    expect(DEFAULT_MEMORY_DB_PATH).toBe(join(homedir(), ".duet", "memory.db"));

    const manager = new SessionManager({ model: "anthropic:claude-opus-4-7" });

    expect(manager.config.memoryDbPath).toBe(join(homedir(), ".duet", "memory.db"));
  });

  test("preserves disabled durable memory storage", () => {
    const manager = new SessionManager({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
    });

    expect(manager.config.memoryDbPath).toBe(false);
  });

  testIfDocker("creates and stores multiple sessions with manager-wrapped events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-manager-"));
    tempDirs.push(tempDir);
    const runners = new Map<string, FakeTurnRunner>();
    const manager = new SessionManager(
      { model: "anthropic:claude-opus-4-7", cwd: tempDir },
      {
        createRunner: (sessionId) => {
          const runner = new FakeTurnRunner([complete(sessionId)]);
          runners.set(sessionId, runner);
          return runner;
        },
        sessionStoragePath: join(tempDir, ".duet", "sessions"),
      },
    );
    const events: Array<{ sessionId: string; event: TurnEvent }> = [];
    manager.subscribe((event) => events.push(event));

    const first = manager.create({ sessionId: "first", prompt: "one" });
    const second = manager.create({ sessionId: "second", prompt: "two" });
    await first.waitForTerminal();
    await second.waitForTerminal();

    expect(manager.get("first")).toBe(first);
    expect(manager.get("second")).toBe(second);
    expect(runners.get("first")?.commands).toEqual([
      { type: "prompt", message: "one", behavior: "follow_up" },
    ]);
    expect(runners.get("second")?.commands).toEqual([
      { type: "prompt", message: "two", behavior: "follow_up" },
    ]);
    expect(
      events.some((event) => event.sessionId === "first" && event.event.type === "turn_started"),
    ).toBe(true);
    expect(
      events.some((event) => event.sessionId === "second" && event.event.type === "turn_started"),
    ).toBe(true);
    expect(manager.config.memoryDbPath).toBe(join(homedir(), ".duet", "memory.db"));

    const firstState = await readFile(
      join(tempDir, ".duet", "sessions", "first", "state.json"),
      "utf-8",
    );
    expect(JSON.parse(firstState).sessionId).toBe("first");

    await manager.dispose();
  });

  testIfDocker("resumes one session without relying on turn state object identity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-manager-"));
    tempDirs.push(tempDir);
    const runner = new FakeTurnRunner([complete("resumed")]);
    const manager = new SessionManager(
      { model: "anthropic:claude-opus-4-7", cwd: tempDir },
      { createRunner: () => runner, sessionStoragePath: join(tempDir, ".duet", "sessions") },
    );
    const events: Array<{ sessionId: string; event: TurnEvent }> = [];
    manager.subscribe((event) => events.push(event));

    const session = manager.resume("resumable");
    await session.start();
    await session.prompt({ message: "resume" });
    await session.waitForTerminal();

    expect(manager.get("resumable")).toBe(session);
    expect(events.at(-1)).toMatchObject({
      sessionId: "resumable",
      event: { type: "complete" },
    });

    await manager.dispose();
  });
});
