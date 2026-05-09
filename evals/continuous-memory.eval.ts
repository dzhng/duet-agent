import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationalContextTransform,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "../src/memory/observational-prompts.js";
import { MemoryStore } from "../src/memory/store.js";
import { createInitialHorizon } from "../src/turn-runner/wire-shaping.js";
import { SessionManager } from "../src/session/session-manager.js";
import type { ObservationalMemoryActivityEvent } from "../src/types/memory.js";
import type { TurnEvent, TurnTerminalEvent } from "../src/types/protocol.js";
import { waitFor } from "../test/helpers/async.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const memoryModel = DEFAULT_CLI_MEMORY_MODEL;

describe("continuous memory", () => {
  testIfDocker(
    "handles a single low-signal prompt through the session runner",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-continuous-memory-"));
      const events: TurnEvent[] = [];
      const manager = new SessionManager(
        {
          model,
          memoryModel,
          cwd: tempDir,
          memoryDbPath: join(tempDir, "memory.db"),
          skillDiscovery: { includeDefaults: false },
        },
        { sessionStoragePath: join(tempDir, "sessions") },
      );
      manager.subscribe((event) => events.push(event.event));

      try {
        const session = manager.create({ mode: "agent" });
        await session.start();

        await session.prompt({ message: "hi" });
        await waitForNextTerminalOrThrow(events, 0);

        const systemErrors = events.filter(
          (event) => event.type === "system" && event.level === "error",
        );
        expect(systemErrors).toEqual([]);
        expect(
          events.some((event) => event.type === "memory" && event.status === "completed"),
        ).toBe(true);
      } finally {
        await manager.dispose();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  testIfDocker(
    "uses hasMemory=false for two low-signal user prompts",
    async () => {
      const memory = new MemoryStore();
      const events: ObservationalMemoryActivityEvent[] = [];
      const firstPrompt: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "hello world" }],
          timestamp: Date.now(),
        },
      ];
      const secondPrompt: AgentMessage[] = [
        ...firstPrompt,
        {
          role: "user",
          content: [{ type: "text", text: "hey can you hear me?" }],
          timestamp: Date.now() + 1,
        },
      ];

      await updateObservationalMemory({
        memory,
        actorModel: memoryModel,
        settings: {
          observation: {
            messageTokens: 10_000,
            maxTokensPerBatch: 200,
            bufferActivation: 1_000,
          },
          reflection: {
            observationTokens: 10_000,
            bufferActivation: 5_000,
          },
        },
        messages: firstPrompt,
        onActivity: (event) => events.push(event),
      });
      await updateObservationalMemory({
        memory,
        actorModel: memoryModel,
        settings: {
          observation: {
            messageTokens: 10_000,
            maxTokensPerBatch: 200,
            bufferActivation: 1_000,
          },
          reflection: {
            observationTokens: 10_000,
            bufferActivation: 5_000,
          },
        },
        messages: secondPrompt,
        onActivity: (event) => events.push(event),
      });

      const snapshot = await memory.getSnapshot();
      expect(snapshot.observations).toEqual([]);
      expect(events).toContainEqual({
        phase: "observation",
        status: "completed",
        message: "Memory observation complete.",
      });
    },
    30_000,
  );

  testIfDocker(
    "keeps previous observations bounded for low-signal prompts",
    async () => {
      const memory = new MemoryStore();
      const events: ObservationalMemoryActivityEvent[] = [];
      for (let index = 0; index < 80; index++) {
        await memory.appendObservation({
          kind: "observation",
          observedDate: "2026-05-08",
          priority: "high",
          source: { kind: "system" },
          content: `Date: May 8, 2026\n* 🔴 Existing durable memory ${index}: ${"detail ".repeat(200)}`,
          tags: ["seeded"],
        });
      }

      const injectedMemory = await snapshotObservationText(memory);
      await updateObservationalMemory({
        memory,
        actorModel: memoryModel,
        settings: {
          observation: {
            messageTokens: 10_000,
            maxTokensPerBatch: 200,
            bufferActivation: 1_000,
          },
          reflection: {
            observationTokens: 500_000,
            bufferActivation: 100_000,
          },
        },
        messages: [
          {
            role: "user",
            content: `<system-reminder>${OBSERVATION_CONTEXT_PROMPT}\n\n<observations>\n${injectedMemory}\n</observations>\n\n${OBSERVATION_CONTEXT_INSTRUCTIONS}</system-reminder>`,
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            timestamp: Date.now(),
          },
        ],
        onActivity: (event) => events.push(event),
      });

      const snapshot = await memory.getSnapshot();
      expect(
        snapshot.observations.some((observation) =>
          observation.content.includes("Existing durable memory 79"),
        ),
      ).toBe(true);
      expect(events).toContainEqual({
        phase: "observation",
        status: "completed",
        message: "Memory observation complete.",
      });
    },
    30_000,
  );

  testIfDocker(
    "observes pi-turn messages before compaction is required",
    async () => {
      const memory = new MemoryStore();
      const events: ObservationalMemoryActivityEvent[] = [];
      const settings = {
        observation: {
          messageTokens: 10_000,
          maxTokensPerBatch: 500,
          bufferActivation: 1_000,
          instruction:
            "For this eval, always record the marker continuous-memory-318 and the fact that compaction has not been needed yet.",
        },
        reflection: {
          observationTokens: 10_000,
          bufferActivation: 5_000,
        },
      };
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Remember marker continuous-memory-318 before any transcript compaction is needed.",
            },
          ],
          timestamp: Date.now(),
        },
      ];

      await updateObservationalMemory({
        memory,
        actorModel: memoryModel,
        settings,
        messages,
        onActivity: (event) => events.push(event),
      });

      const snapshot = await memory.getSnapshot();
      const observations = snapshot.observations
        .map((observation) => observation.content)
        .join("\n");
      expect(observations).toContain("continuous-memory-318");
      expect(
        events.some((event) => event.status === "completed" && event.observations?.length),
      ).toBe(true);

      const transform = createObservationalContextTransform({
        memory,
        settings,
        horizon: createInitialHorizon(),
      });
      const transformed = await transform(messages);
      expect(transformed.at(-1)).toMatchObject({
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("continuous-memory-318"),
          },
        ],
      });
    },
    30_000,
  );
});

async function snapshotObservationText(memory: MemoryStore): Promise<string> {
  const snapshot = await memory.getSnapshot();
  return snapshot.observations.map((observation) => observation.content).join("\n\n");
}

async function waitForNextTerminalOrThrow(
  events: TurnEvent[],
  previousTerminalCount: number,
): Promise<TurnTerminalEvent> {
  await waitFor(
    () =>
      terminalEvents(events).length > previousTerminalCount ||
      events.some((event) => event.type === "system" && event.level === "error"),
    45_000,
  );
  const error = events.find((event) => event.type === "system" && event.level === "error");
  if (error?.type === "system") {
    throw new Error(error.message);
  }
  const terminal = terminalEvents(events).at(-1);
  if (!terminal) {
    throw new Error("Expected terminal event");
  }
  return terminal;
}

function terminalEvents(events: TurnEvent[]): TurnTerminalEvent[] {
  return events.filter(
    (event): event is TurnTerminalEvent =>
      event.type === "complete" ||
      event.type === "ask" ||
      event.type === "sleep" ||
      event.type === "interrupted",
  );
}
