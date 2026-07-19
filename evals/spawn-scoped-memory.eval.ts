import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySession } from "../src/memory/session.js";
import { appendObservation, readSessionObservations } from "../src/memory/storage.js";
import type { TaskId } from "../src/tasks/types.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnOptions, TurnState } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

class ScopedMemorySpawnRunner extends TurnRunner {
  beforeDrop: string[] = [];
  afterDrop: string[] = [];

  /**
   * PGlite supports one live instance per data dir, so every probe must go
   * through the runner's own connection rather than a second MemorySession.
   */
  memorySession(): MemorySession {
    const session = (this as unknown as { memoryPersistence?: { session: MemorySession } })
      .memoryPersistence?.session;
    if (!session) throw new Error("runner memory session not loaded");
    return session;
  }

  protected override createAgent(input: AgentConfigInput): Agent {
    const agent = super.createAgent(input);
    if (input.memoryContext) {
      agent.prompt = (async () => {
        const transform = this.createMemoryTransform(input.memoryContext);
        const messages = [
          { role: "user", content: "child compaction sentinel ".repeat(60_000), timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
        ] as AgentMessage[];
        await transform(messages);
      }) as typeof agent.prompt;
    }
    return agent;
  }

  protected override async updateMemoryAfterAgentRun(
    _messages: AgentMessage[],
    _options: TurnOptions | undefined,
    sessionId = this.config.sessionId,
    _refreshReflections = true,
  ): Promise<void> {
    if (!sessionId?.includes(":sub:")) {
      throw new Error("Spawn compaction attempted to observe into the parent session.");
    }
    await appendObservation(this.memorySession(), {
      sessionId,
      kind: "observation",
      observedDate: "2026-07-19",
      priority: "medium",
      source: { kind: "system" },
      content: "child compaction sentinel",
      tags: ["spawn-eval"],
    });
  }

  protected override async dropSubagentScratch(taskId: TaskId): Promise<void> {
    const sessionId = `${this.config.sessionId}:sub:${taskId}`;
    this.beforeDrop = (
      await readSessionObservations(this.memorySession(), sessionId)
    ).observations.map(({ content }) => content);
    await super.dropSubagentScratch(taskId);
    this.afterDrop = (
      await readSessionObservations(this.memorySession(), sessionId)
    ).observations.map(({ content }) => content);
  }

  openRootScope(): void {
    (this as unknown as { activeRootScopeId: string }).activeRootScopeId = "root";
  }

  spawn() {
    const tool = this.createTools("agent").tools.find(({ name }) => name === "spawn_agent");
    if (!tool) throw new Error("spawn_agent missing");
    return tool.execute("spawn-memory", { prompt: "force child compaction" });
  }

  setConcreteState(): void {
    const state = this.getState();
    if (!state) throw new Error("runner not started");
    (this as unknown as { state: TurnState }).state = state;
  }
}

describe("spawn-scoped memory", () => {
  testIfDocker(
    "compaction observes under :sub: and scope close drops scratch without touching parent rows",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-spawn-memory-"));
      const runner = new ScopedMemorySpawnRunner({
        sessionId: "parent",
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: join(dir, "memory.db"),
        skillDiscovery: { includeDefaults: false },
      });

      // Falsification: pass the parent session id to the child transform; the injected observer
      // throws before writing and the beforeDrop sentinel assertion turns red.
      await runner.start({ type: "start", mode: "agent" });
      await appendObservation(runner.memorySession(), {
        sessionId: "parent",
        kind: "observation",
        observedDate: "2026-07-19",
        priority: "high",
        source: { kind: "user" },
        content: "parent memory sentinel",
        tags: ["parent"],
      });
      const parentBefore = await readSessionObservations(runner.memorySession(), "parent");
      runner.setConcreteState();
      runner.openRootScope();
      await runner.spawn();

      expect(runner.beforeDrop).toEqual(["child compaction sentinel"]);
      expect(runner.afterDrop).toEqual([]);
      const parentAfter = await readSessionObservations(runner.memorySession(), "parent");
      expect(parentAfter.observations).toEqual(parentBefore.observations);
      await runner.dispose();
    },
    120_000,
  );
});
