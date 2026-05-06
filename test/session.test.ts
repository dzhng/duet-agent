import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Session, type SessionTurnRunner } from "../src/session/session.js";
import {
  DEFAULT_MEMORY_DB_PATH,
  DEFAULT_SESSION_STORAGE_DIR,
  SessionManager,
} from "../src/session/session-manager.js";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { SkillCollision } from "../src/turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnEvent,
  TurnEditFollowUpQueueCommand,
  TurnInterruptCommand,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
} from "../src/types/protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { waitFor } from "./helpers/async.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class FakeTurnRunner implements SessionTurnRunner {
  readonly commands: TurnCommand[] = [];
  readonly interrupts: TurnInterruptCommand[] = [];
  readonly followUpQueueEdits: TurnEditFollowUpQueueCommand[] = [];
  readonly handlers = new Set<(event: TurnEvent) => void>();
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

  async start(_command: TurnStartCommand): Promise<TurnState> {
    this.emit({ type: "session_started", state: turnState });
    return turnState;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.commands.push(command);
    if (command.type === "wake" && this.terminals.length === 0) {
      const terminal: TurnTerminalEvent = {
        type: "complete",
        status: "completed",
        result: "Nothing to wake.",
        state: command.state,
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
        ...command.state,
        status: "interrupted",
        agent: { ...command.state.agent, status: "cancelled" },
        stateMachine: command.state.stateMachine
          ? {
              ...command.state.stateMachine,
              terminal: { state: "interrupted", status: "cancelled" },
              history: [
                ...command.state.stateMachine.history,
                {
                  type: "session_completed",
                  timestamp: Date.now(),
                  terminal: { state: "interrupted", status: "cancelled" },
                },
              ],
            }
          : undefined,
      },
    };
    this.terminals.push(terminal);
    this.emit(terminal);
    this.resolveNext();
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.followUpQueueEdits.push(command);
    this.emit({ type: "follow_up_queue", prompts: command.prompts });
  }

  subscribe(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getSkills(): Promise<readonly Skill[]> {
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

function complete(result = "done"): TurnTerminalEvent {
  return {
    type: "complete",
    status: "completed",
    result,
    state: turnState,
  };
}

describe("Session", () => {
  testIfDocker("starts a session without waiting for the runner terminal event", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "hello" });
    await session.waitForTerminal();

    expect(session.id).toStartWith("session_");
    expect(runner.commands).toEqual([
      { type: "prompt", state: turnState, message: "hello", behavior: "follow_up" },
    ]);
  });

  testIfDocker("forwards follow-up queue edits to the runner", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);
    const events: TurnEvent[] = [];
    session.subscribe((event) => events.push(event));

    session.editFollowUpQueue({ prompts: ["after this"] });

    expect(runner.followUpQueueEdits).toEqual([
      { type: "edit_follow_up_queue", prompts: ["after this"] },
    ]);
    expect(events).toContainEqual({ type: "follow_up_queue", prompts: ["after this"] });
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

    expect(events[0]).toMatchObject({ type: "session_started" });
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
      { type: "prompt", state: turnState, message: "poll", behavior: "follow_up" },
      { type: "wake", state: sleeping },
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
      { type: "prompt", state: turnState, message: "continue", behavior: "follow_up" },
    ]);
  });

  testIfDocker("sends active prompts through turn runner", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);

    await session.start();
    await session.prompt({ message: "start" });
    await waitFor(() => runner.commands.length === 1);
    await session.prompt({ message: "steer now", behavior: "steer" });

    expect(runner.commands).toEqual([
      { type: "prompt", state: turnState, message: "start", behavior: "follow_up" },
      { type: "prompt", state: turnState, message: "steer now", behavior: "steer" },
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
      { type: "prompt", state: turnState, message: "start", behavior: "follow_up" },
      { type: "prompt", state: turnState, message: "queue later", behavior: "follow_up" },
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
      answers: { choice: "A" },
    });

    expect(runner.commands.at(-1)).toMatchObject({
      type: "answer",
      state: waiting,
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
    const staleWake = await runner.turn({ type: "wake", state: interrupted.state });

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
      const completedStillWaiting: TurnState = {
        ...sleeping,
        status: "completed",
        agent: { ...sleeping.agent, status: "completed" },
      };
      const runner = new FakeTurnRunner([
        { type: "sleep", wakeAt: Date.now() + 60_000, state: sleeping },
      ]);
      const session = await createSession(runner);

      await session.start();
      await session.prompt({ message: "poll" });
      await session.waitForTerminal();
      await session.prompt({ message: "anything new?" });
      runner.terminals.push({
        type: "complete",
        status: "completed",
        state: completedStillWaiting,
      });
      runner.resolveNext();
      const terminal = await session.waitForTerminal();

      expect(terminal).toMatchObject({
        type: "sleep",
        state: { status: "sleeping", stateMachine: { currentState: "poll_email_reply" } },
      });
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
        { type: "prompt", state: turnState, message: "start", behavior: "follow_up" },
        { type: "prompt", state: turnState, message: "next", behavior: "follow_up" },
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
      { type: "prompt", state: turnState, message: "one", behavior: "follow_up" },
    ]);
    expect(runners.get("second")?.commands).toEqual([
      { type: "prompt", state: turnState, message: "two", behavior: "follow_up" },
    ]);
    expect(
      events.some((event) => event.sessionId === "first" && event.event.type === "session_started"),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.sessionId === "second" && event.event.type === "session_started",
      ),
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
