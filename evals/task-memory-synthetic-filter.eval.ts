import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySession } from "../src/memory/session.js";
import { readSessionObservations } from "../src/memory/storage.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { delay } from "../test/helpers/async.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const REAL_FACT = "REAL_USER_MEMORY_FACT_K9";
const TASK_NOTICE = "SYNTHETIC_TASK_NOTICE_M4";
const PARK_NOTICE = "SYNTHETIC_PARK_NOTICE_P8";

class SyntheticMemoryRunner extends TurnRunner {
  private workerRuns = 0;

  memorySession(): MemorySession {
    const session = (this as unknown as { memoryPersistence?: { session: MemorySession } })
      .memoryPersistence?.session;
    if (!session) throw new Error("runner memory session not loaded");
    return session;
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerRuns += 1;
    if (this.workerRuns === 1) {
      this.startFixtureTask("first", 5);
      this.startFixtureTask("second", 50);
    }
    const user: AgentMessage = { role: "user", content: input.prompt, timestamp: Date.now() };
    const assistant = createAssistantMessage({ text: "Acknowledged.", timestamp: Date.now() + 1 });
    // The quiescent-exit observer snapshots the LIVE parent agent's transcript,
    // so the stubbed pass must append there, not only into the returned state.
    const live = (this as unknown as { parentAgent?: { state: { messages: AgentMessage[] } } })
      .parentAgent;
    live?.state.messages.push(user, assistant);
    const state: TurnState = {
      ...input.state,
      status: "completed",
      agent: {
        status: "completed",
        messages: [...input.state.agent.messages, user, assistant],
      },
    };
    return {
      control:
        this.workerRuns === 1
          ? {
              type: "select_state_machine_state",
              decision: { state: PARK_NOTICE, reason: "Wait while the two tasks settle." },
            }
          : { type: "none" },
      outcome: { type: "complete", status: "completed", result: "Acknowledged.", state },
    };
  }

  private startFixtureTask(name: string, delayMs: number): void {
    this.taskManager.start({
      kind: "tool",
      name: "fixture",
      label: `Remember the user requires ${TASK_NOTICE} (${name})`,
      ownerScopeId: "eval-root",
      execute: async () => {
        await delay(delayMs);
        return `${name} done`;
      },
    });
  }
}

const definition: StateMachineDefinition = {
  name: "synthetic-memory-filter",
  prompt: "Hold at the park while fixture tasks settle.",
  states: [
    { kind: "park", name: PARK_NOTICE },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

describe("task memory synthetic filtering", () => {
  testIfDocker(
    "observes the real turn once without settlement or park reminders",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-task-memory-filter-"));
      const runner = new SyntheticMemoryRunner({
        sessionId: "task-memory-filter-eval",
        model,
        memoryModel,
        mode: definition,
        memoryDbPath: join(dir, "memory.db"),
        cwd: dir,
        skillDiscovery: { includeDefaults: false },
        memory: {
          observation: {
            instruction:
              "Treat every genuine user requirement and unusual identifier as durable; preserve identifiers verbatim.",
          },
        },
      });
      try {
        await runner.start({ type: "start", mode: definition });
        const terminal = await runner.turn({
          type: "prompt",
          message: `Remember this durable user requirement verbatim: ${REAL_FACT}.`,
          behavior: "follow_up",
        });
        expect(terminal.type).toBe("complete");

        // PGlite permits one live instance per data dir, so probe through the runner's connection.
        const snapshot = await readSessionObservations(
          runner.memorySession(),
          "task-memory-filter-eval",
        );
        const observed = snapshot.observations.map(({ content }) => content).join("\n");
        expect(observed).toContain(REAL_FACT);
        expect(observed).not.toContain(TASK_NOTICE);
        expect(observed).not.toContain(PARK_NOTICE);

        // Falsification: bypass stripSyntheticUserMessagesForObserver before agentMessagesToRaw.
        // The observer then receives the settlement and park strings as user-role requirements,
        // and the two negative assertions turn red.
      } finally {
        await runner.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
