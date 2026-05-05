import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Orchestrator, type OrchestratorHarness } from "../src/orchestrator/orchestrator.js";
import type {
  HarnessEvent,
  HarnessTerminalTurnEvent,
  HarnessTurnCommand,
} from "../src/types/protocol.js";
import { createStateMachineSession } from "./helpers/harness-protocol.js";

class FakeHarness implements OrchestratorHarness {
  readonly commands: HarnessTurnCommand[] = [];
  readonly handlers = new Set<(event: HarnessEvent) => void>();
  skills: readonly { name: string }[] = [];
  skillInstructions = new Map<string, string>();
  disposed = false;
  terminals: HarnessTerminalTurnEvent[];

  constructor(terminals: HarnessTerminalTurnEvent[]) {
    this.terminals = [...terminals];
  }

  async turn(command: HarnessTurnCommand): Promise<HarnessTerminalTurnEvent> {
    this.commands.push(command);
    const terminal = this.terminals.shift();
    if (!terminal) throw new Error("Fake harness terminal queue exhausted");
    return terminal;
  }

  subscribe(handler: (event: HarnessEvent) => void): () => void {
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

  emit(event: HarnessEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

const session = createStateMachineSession("draft");
let tempDirs: string[] = [];

async function createOrchestrator(
  harness: FakeHarness,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<Orchestrator> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
  tempDirs.push(tempDir);
  return new Orchestrator(
    { harnessModel: "anthropic:claude-opus-4-6" },
    { harness, sessionStoragePath: tempDir, ...options },
  );
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function complete(result = "done"): HarnessTerminalTurnEvent {
  return {
    type: "complete",
    status: "completed",
    result,
    session,
  };
}

describe("Orchestrator", () => {
  test("runs a simple prompt through the harness wrapper", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);

    const result = await orchestrator.run({ prompt: "hello" });

    expect(result.sessionId).toStartWith("session_");
    expect(result.terminal.type).toBe("complete");
    expect(harness.commands).toEqual([{ type: "start", mode: undefined, prompt: "hello" }]);
  });

  test("forwards harness events through subscribe", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);
    const events: HarnessEvent[] = [];

    const unsubscribe = orchestrator.subscribe((event) => events.push(event));
    harness.emit({ type: "ready" });
    unsubscribe();
    harness.emit({ type: "log", level: "info", message: "ignored" });

    expect(events).toEqual([{ type: "ready" }]);
  });

  test("wakes sleeping sessions and stops after completion", async () => {
    const harness = new FakeHarness([
      { type: "sleep", wakeAt: Date.now() + 10_000, session },
      complete("awake"),
    ]);
    const sleepDurations: number[] = [];
    const orchestrator = await createOrchestrator(harness, {
      sleep: async (ms) => {
        sleepDurations.push(ms);
      },
    });

    const result = await orchestrator.run({ prompt: "poll" });

    expect(result.terminal).toMatchObject({ type: "complete", result: "awake" });
    expect(sleepDurations[0]).toBeGreaterThan(0);
    expect(harness.commands).toEqual([
      { type: "start", mode: undefined, prompt: "poll" },
      { type: "wake", session },
    ]);
  });

  test("stops after ask or interrupted terminal events", async () => {
    const askHarness = new FakeHarness([{ type: "ask", questions: [], session }]);
    const interruptedHarness = new FakeHarness([{ type: "interrupted", session }]);

    await (
      await createOrchestrator(askHarness)
    ).run({
      prompt: "question",
    });
    await (await createOrchestrator(interruptedHarness)).run({ prompt: "stop" });

    expect(askHarness.commands).toHaveLength(1);
    expect(interruptedHarness.commands).toHaveLength(1);
  });

  test("disposes harness resources", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);

    await orchestrator.dispose();

    expect(harness.disposed).toBe(true);
  });

  test("persists session history snapshots by session id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const harness = new FakeHarness([complete("stored")]);
    const orchestrator = new Orchestrator(
      { harnessModel: "anthropic:claude-opus-4-6" },
      { harness, sessionStoragePath: tempDir },
    );

    const result = await orchestrator.run({ sessionId: "existing-session", prompt: "remember me" });
    const content = await readFile(join(tempDir, "existing-session.json"), "utf-8");
    const stored = JSON.parse(content);

    expect(result.sessionId).toBe("existing-session");
    expect(stored.sessionId).toBe("existing-session");
    expect(stored.session.agent.messages).toEqual(session.agent.messages);
  });

  test("continues existing stored sessions with prompt commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-session-"));
    tempDirs.push(tempDir);
    const firstHarness = new FakeHarness([complete("first")]);
    await new Orchestrator(
      { harnessModel: "anthropic:claude-opus-4-6" },
      { harness: firstHarness, sessionStoragePath: tempDir },
    ).run({ sessionId: "continuable", prompt: "start" });
    const secondHarness = new FakeHarness([complete("second")]);

    await new Orchestrator(
      { harnessModel: "anthropic:claude-opus-4-6" },
      { harness: secondHarness, sessionStoragePath: tempDir },
    ).run({ sessionId: "continuable", prompt: "continue" });

    expect(secondHarness.commands).toEqual([
      { type: "prompt", session, message: "continue", behavior: "steer" },
    ]);
  });

  test("keeps an active session id for subsequent user messages", async () => {
    const harness = new FakeHarness([complete("first"), complete("second")]);
    const orchestrator = await createOrchestrator(harness);

    const first = await orchestrator.run({ prompt: "start" });
    const second = await orchestrator.run({ prompt: "next message" });

    expect(second.sessionId).toBe(first.sessionId);
    expect(harness.commands).toEqual([
      { type: "start", mode: undefined, prompt: "start" },
      { type: "prompt", session, message: "next message", behavior: "steer" },
    ]);
  });

  test("passes slash commands through to the harness", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);

    await orchestrator.run({ prompt: "/review audit this diff" });

    const [command] = harness.commands;
    expect(command).toMatchObject({ type: "start" });
    if (command.type !== "start") throw new Error("Expected start command");
    expect(command.prompt).toBe("/review audit this diff");
  });

  test("passes unknown slash commands through to the harness", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);

    await orchestrator.run({ prompt: "/missing do work" });

    expect(harness.commands).toEqual([
      { type: "start", mode: undefined, prompt: "/missing do work" },
    ]);
  });

  test("leaves non-slash prompts unchanged", async () => {
    const harness = new FakeHarness([complete()]);
    const orchestrator = await createOrchestrator(harness);

    await orchestrator.run({ prompt: "regular prompt" });

    expect(harness.commands).toEqual([
      { type: "start", mode: undefined, prompt: "regular prompt" },
    ]);
  });
});
