import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationalContextTransform,
  DEFAULT_EFFECTIVE_CONTEXT,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "../src/memory/observational-prompts.js";
import { createMemoryFixture, type MemoryFixture } from "../test/helpers/memory-fixture.js";
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
        // The observer fires its phase event; the completion event is
        // suppressed when the low-signal turn produced no new observation
        // and bumped no prior memories. Only assert that the memory phase
        // ran without errors, not that a `completed` event was emitted.
        expect(events.some((event) => event.type === "memory")).toBe(true);
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
      const fixture = await createMemoryFixture();
      const events: ObservationalMemoryActivityEvent[] = [];
      try {
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
          session: fixture.session,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          messages: firstPrompt,
          onActivity: (event) => events.push(event),
        });
        await updateObservationalMemory({
          session: fixture.session,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          messages: secondPrompt,
          onActivity: (event) => events.push(event),
        });

        const snapshot = await fixture.snapshot("session_eval");
        expect(snapshot.observations).toEqual([]);
        // Low-signal turns produce hasMemory=false with no bumps, so the
        // completion event is intentionally suppressed. The observation
        // phase still starts, which is what we assert here.
        expect(events).toContainEqual({
          phase: "observation",
          status: "running",
          message: "Observing conversation into memory...",
        });
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );

  testIfDocker(
    "keeps previous observations bounded for low-signal prompts",
    async () => {
      const fixture = await createMemoryFixture();
      const events: ObservationalMemoryActivityEvent[] = [];
      try {
        for (let index = 0; index < 80; index++) {
          await fixture.append({
            sessionId: "session_eval",
            kind: "observation",
            observedDate: "2026-05-08",
            priority: "high",
            source: { kind: "system" },
            content: `Date: May 8, 2026\n* 🔴 Existing durable memory ${index}: ${"detail ".repeat(200)}`,
            tags: ["seeded"],
          });
        }

        const injectedMemory = await snapshotObservationText(fixture);
        await updateObservationalMemory({
          session: fixture.session,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
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

        const snapshot = await fixture.snapshot("session_eval");
        expect(
          snapshot.observations.some((observation) =>
            observation.content.includes("Existing durable memory 79"),
          ),
        ).toBe(true);
        // Low-signal "hi" against seeded high-priority memories does not
        // bump anything, so the completion event is suppressed. Assert
        // the observation phase started instead.
        expect(events).toContainEqual({
          phase: "observation",
          status: "running",
          message: "Observing conversation into memory...",
        });
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );

  testIfDocker(
    "observes pi-turn messages before compaction is required",
    async () => {
      const fixture = await createMemoryFixture();
      const events: ObservationalMemoryActivityEvent[] = [];
      const settings = {
        observation: {
          instruction:
            "For this eval, always record the marker continuous-memory-318 and the fact that compaction has not been needed yet.",
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

      try {
        await updateObservationalMemory({
          session: fixture.session,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          settings,
          messages,
          onActivity: (event) => events.push(event),
        });

        const snapshot = await fixture.snapshot("session_eval");
        const observations = snapshot.observations
          .map((observation) => observation.content)
          .join("\n");
        expect(observations).toContain("continuous-memory-318");
        expect(
          events.some((event) => event.status === "completed" && event.observations?.length),
        ).toBe(true);

        const transform = createObservationalContextTransform({
          memory: fixture.cache,
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
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
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );
});

async function snapshotObservationText(fixture: MemoryFixture): Promise<string> {
  const snapshot = await fixture.snapshot("session_eval");
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
