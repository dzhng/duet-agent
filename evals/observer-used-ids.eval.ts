import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * Live-model checks on the observer's `usedObservationIds` output.
 *
 * The structured-output schema and the prompt both ask the observer
 * to cite memory ids drawn from the rendered `[memory id: mem_xxx]`
 * markers. These tests pin two contracts:
 *
 *   1. When the assistant clearly leans on one memory among several
 *      decoys, the observer cites that one and only that one.
 *   2. When the assistant's response has nothing to do with any of
 *      the rendered memories, the observer does not invent ids.
 *
 * Failures here usually mean the prompt section in
 * `observational-prompts.ts` drifted away from the schema description
 * or that the observer model regressed on instruction following.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

const settings = resolveObservationalMemorySettings({
  observation: {
    messageTokens: 10_000,
    maxTokensPerBatch: 800,
    bufferActivation: 1_000,
  },
  reflection: {
    observationTokens: 200_000,
    bufferActivation: 100_000,
  },
});

describe("observer usedObservationIds", () => {
  testIfDocker(
    "cites the single relevant memory and ignores unrelated decoys",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const deployCmd = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "high",
          source: { kind: "system" },
          content:
            "User confirmed the canonical deploy command for the api service is `pnpm deploy:prod`.",
          tags: ["seeded"],
        });
        const cat = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "high",
          source: { kind: "system" },
          content: "User mentioned their cat is named Pixel and is a 3-year-old tabby.",
          tags: ["seeded"],
        });
        const breakfast = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "medium",
          source: { kind: "system" },
          content: "User typically eats oatmeal for breakfast on weekdays.",
          tags: ["seeded"],
        });

        await rebuildMemoryContextPack({
          db: fixture.db,
          cache: fixture.cache,
          settings,
          sessionId: "session_eval",
        });

        const messages: AgentMessage[] = [
          {
            role: "user",
            content: [{ type: "text", text: "How do I deploy the api service?" }],
            timestamp: Date.now(),
          },
          createAssistantMessage({
            text: "Run `pnpm deploy:prod` — that's the canonical command you confirmed earlier for shipping the api service.",
            timestamp: Date.now() + 1,
          }),
        ];

        const seedTime = Date.now() - 24 * 60 * 60 * 1000;
        await fixture.db.query(
          "UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = ANY($2::text[])",
          [seedTime, [deployCmd.id, cat.id, breakfast.id]],
        );

        await updateObservationalMemory({
          db: fixture.db,
          memory: fixture.cache,
          sessionId: "session_eval",
          actorModel: memoryModel,
          settings,
          messages,
        });

        const rows = await readLastUsed(fixture.db, [deployCmd.id, cat.id, breakfast.id]);

        // The deploy command is the only memory the assistant could
        // have leaned on. lastUsedAt advanced means the observer
        // emitted that id; the decoys staying at the seeded -1d
        // timestamp means the observer did not over-cite.
        expect(rows[deployCmd.id]).toBeGreaterThan(seedTime + 60_000);
        expect(rows[cat.id]).toBe(seedTime);
        expect(rows[breakfast.id]).toBe(seedTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "does not cite any memory when the response is unrelated to the rendered pack",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const cat = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "high",
          source: { kind: "system" },
          content: "User mentioned their cat is named Pixel and is a 3-year-old tabby.",
          tags: ["seeded"],
        });
        const breakfast = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "medium",
          source: { kind: "system" },
          content: "User typically eats oatmeal for breakfast on weekdays.",
          tags: ["seeded"],
        });

        await rebuildMemoryContextPack({
          db: fixture.db,
          cache: fixture.cache,
          settings,
          sessionId: "session_eval",
        });

        // The exchange below is a pure factual question with no
        // overlap to the seeded memories.
        const messages: AgentMessage[] = [
          {
            role: "user",
            content: [{ type: "text", text: "What is 17 times 23? Just the number." }],
            timestamp: Date.now(),
          },
          createAssistantMessage({
            text: "391",
            timestamp: Date.now() + 1,
          }),
        ];

        const seedTime = Date.now() - 24 * 60 * 60 * 1000;
        await fixture.db.query(
          "UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = ANY($2::text[])",
          [seedTime, [cat.id, breakfast.id]],
        );

        await updateObservationalMemory({
          db: fixture.db,
          memory: fixture.cache,
          sessionId: "session_eval",
          actorModel: memoryModel,
          settings,
          messages,
        });

        const rows = await readLastUsed(fixture.db, [cat.id, breakfast.id]);

        // Neither memory was used; both timestamps must stay at the
        // seeded backdate. A bump would mean the observer hallucinated
        // a citation, which is exactly the failure mode the prompt
        // and id-validation guard are supposed to prevent.
        expect(rows[cat.id]).toBe(seedTime);
        expect(rows[breakfast.id]).toBe(seedTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});

async function readLastUsed(
  db: Awaited<ReturnType<typeof createMemoryFixture>>["db"],
  ids: string[],
): Promise<Record<string, number>> {
  const result = await db.query<{ id: string; last_used_at: number }>(
    "SELECT id, last_used_at FROM observations WHERE id = ANY($1::text[])",
    [ids],
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    out[row.id] = row.last_used_at;
  }
  return out;
}
