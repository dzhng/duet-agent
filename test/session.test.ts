import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Session, SessionManager, type SessionTurnRunner } from "../src/session/session.js";
import type {
  TurnEvent,
  TurnInterruptCommand,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
} from "../src/types/protocol.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class FakeTurnRunner implements SessionTurnRunner {
  readonly commands: TurnCommand[] = [];
  readonly interrupts: TurnInterruptCommand[] = [];
  readonly handlers = new Set<(event: TurnEvent) => void>();
  skills: readonly { name: string }[] = [];
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

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.commands.push(command);
    this.emit({ type: "ready" });
    if (command.type === "start") {
      this.emit({ type: "session_started", state: turnState });
    }
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

  subscribe(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getSkills(): Promise<readonly { name: string }[]> {
    return this.skills;
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
    { model: "anthropic:claude-opus-4-6" },
    { runner: runner, sessionStoragePath: tempDir },
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
  test("starts a session without waiting for the runner terminal event", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);

    await session.start({ prompt: "hello" });
    await session.waitForTerminal();

    expect(session.id).toStartWith("session_");
    expect(runner.commands).toEqual([{ type: "start", mode: undefined, prompt: "hello" }]);
  });

  test("wraps runner events with the session id", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);
    const events: TurnEvent[] = [];

    const unsubscribe = session.subscribe((event) => events.push(event));
    await session.start({ prompt: "hello" });
    await session.waitForTerminal();
    unsubscribe();
    runner.emit({ type: "log", level: "info", message: "ignored" });

    expect(events[0]).toEqual({ type: "ready" });
  });

  test("schedules wake after sleep without blocking command submission", async () => {
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    const runner = new FakeTurnRunner([
      { type: "sleep", wakeAt: Date.now(), state: sleeping },
      complete("awake"),
    ]);
    const session = await createSession(runner);

    await session.start({ prompt: "poll" });
    await waitFor(() => runner.commands.length >= 2);

    expect(runner.commands).toEqual([
      { type: "start", mode: undefined, prompt: "poll" },
      { type: "wake", state: sleeping },
    ]);
  });

  test("persists terminal state snapshots by session id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const runner = new FakeTurnRunner([complete("stored")]);
    const session = new Session(
      { model: "anthropic:claude-opus-4-6" },
      { id: "existing-session", runner: runner, sessionStoragePath: tempDir },
    );

    await session.start({ prompt: "remember me" });
    await session.waitForTerminal();
    const content = await readFile(join(tempDir, "existing-session.json"), "utf-8");
    const stored = JSON.parse(content);

    expect(stored.sessionId).toBe("existing-session");
    expect(stored.state.agent.messages).toEqual(turnState.agent.messages);
  });

  test("disposes runner resources", async () => {
    const runner = new FakeTurnRunner([complete()]);
    const session = await createSession(runner);

    await session.dispose();

    expect(runner.disposed).toBe(true);
  });

  test("continues stored sessions with prompt commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const firstTurnRunner = new FakeTurnRunner([complete("first")]);
    const first = new Session(
      { model: "anthropic:claude-opus-4-6" },
      { id: "continuable", runner: firstTurnRunner, sessionStoragePath: tempDir },
    );
    await first.start({ prompt: "start" });
    await first.waitForTerminal();
    const secondTurnRunner = new FakeTurnRunner([complete("second")]);

    const second = new Session(
      { model: "anthropic:claude-opus-4-6" },
      { id: "continuable", runner: secondTurnRunner, sessionStoragePath: tempDir },
    );
    await second.start({ prompt: "continue" });
    await second.waitForTerminal();

    expect(secondTurnRunner.commands).toEqual([
      { type: "prompt", state: turnState, message: "continue", behavior: "steer" },
    ]);
  });

  test("forwards steer and follow-up prompts while a turn is active", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);

    await session.start({ prompt: "start" });
    await waitFor(() => runner.commands.length === 1);
    await session.prompt({ message: "steer now", behavior: "steer" });
    await session.prompt({ message: "queue later", behavior: "follow_up" });

    expect(runner.commands).toEqual([
      { type: "start", mode: undefined, prompt: "start" },
      { type: "prompt", state: turnState, message: "steer now", behavior: "steer" },
      { type: "prompt", state: turnState, message: "queue later", behavior: "follow_up" },
    ]);
  });

  test("routes answers with the latest live state", async () => {
    const waiting = { ...turnState, status: "waiting_for_human" as const };
    const runner = new FakeTurnRunner([{ type: "ask", questions: [], state: waiting }]);
    const session = await createSession(runner);

    await session.start({ prompt: "question" });
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

  test("interrupts active state-machine work and persists the interrupted marker", async () => {
    const runner = new FakeTurnRunner([]);
    const session = await createSession(runner);

    await session.start({ prompt: "start" });
    await waitFor(() => runner.commands.length === 1);
    await session.interrupt();
    const terminal = await session.waitForTerminal();

    expect(runner.interrupts).toHaveLength(1);
    expect(terminal.state.stateMachine?.terminal).toMatchObject({
      state: "interrupted",
      status: "cancelled",
    });
  });

  test("stale wake after interrupting sleeping state is a no-op", async () => {
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

    await session.start({ prompt: "poll" });
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

  test("returns sleeping sessions to sleep after user prompts while still waiting", async () => {
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

    await session.start({ prompt: "poll" });
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
  });

  test("allows a complete turn to be followed by another prompt on the same session", async () => {
    const runner = new FakeTurnRunner([complete("first"), complete("second")]);
    const session = await createSession(runner);

    await session.start({ prompt: "start" });
    await session.waitForTerminal();
    await session.prompt({ message: "next" });

    expect(runner.commands).toEqual([
      { type: "start", mode: undefined, prompt: "start" },
      { type: "prompt", state: turnState, message: "next", behavior: "steer" },
    ]);
  });
});

describe("SessionManager", () => {
  test("creates and stores multiple sessions with manager-wrapped events", async () => {
    const runners = new Map<string, FakeTurnRunner>();
    const manager = new SessionManager(
      { model: "anthropic:claude-opus-4-6" },
      {
        createRunner: (sessionId) => {
          const runner = new FakeTurnRunner([complete(sessionId)]);
          runners.set(sessionId, runner);
          return runner;
        },
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
      { type: "start", mode: undefined, prompt: "one" },
    ]);
    expect(runners.get("second")?.commands).toEqual([
      { type: "start", mode: undefined, prompt: "two" },
    ]);
    expect(
      events.some((event) => event.sessionId === "first" && event.event.type === "ready"),
    ).toBe(true);
    expect(
      events.some((event) => event.sessionId === "second" && event.event.type === "ready"),
    ).toBe(true);

    await manager.dispose();
  });

  test("resumes one session without relying on turn state object identity", async () => {
    const runner = new FakeTurnRunner([complete("resumed")]);
    const manager = new SessionManager(
      { model: "anthropic:claude-opus-4-6" },
      { createRunner: () => runner },
    );
    const events: Array<{ sessionId: string; event: TurnEvent }> = [];
    manager.subscribe((event) => events.push(event));

    const session = manager.resume("resumable");
    await session.start({ prompt: "resume" });
    await session.waitForTerminal();

    expect(manager.get("resumable")).toBe(session);
    expect(events.at(-1)).toMatchObject({
      sessionId: "resumable",
      event: { type: "complete" },
    });

    await manager.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}
