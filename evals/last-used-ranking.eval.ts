import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * End-to-end check that the `lastUsedAt` usage signal actually moves
 * memories in the global ranking when a real observer model identifies
 * one of them as having informed the assistant's response.
 *
 * Setup:
 *   - Two cross-session memories pre-seeded with `lastUsedAt = createdAt = -10d`,
 *     identical priority and kind so age is the only differentiator.
 *   - One memory ("kept_marker") describes a unique fact the simulated
 *     turn obviously leans on; the other ("unused_marker") describes a
 *     completely unrelated fact.
 *   - The simulated turn has the assistant explicitly cite the kept
 *     marker so the observer model has unambiguous signal.
 *
 * Expected:
 *   - After the observer pass, the kept marker's `lastUsedAt` is
 *     advanced to roughly "now"; the unused marker's stays at the
 *     seeded -10d timestamp.
 *   - On the next context-pack rebuild the kept marker outranks the
 *     unused marker. Without the bump, both rows would tie in the
 *     ranking formula and order would be undefined.
 *
 * If the observer model fails to populate `usedObservationIds` for a
 * blatantly cited memory, this eval is the canary.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

describe("last-used ranking", () => {
  testIfDocker(
    "observer-reported usage bumps lastUsedAt and re-ranks the global pack",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const seedTime = Date.now() - TEN_DAYS_MS;

        const kept = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: new Date(seedTime).toISOString().slice(0, 10),
          priority: "high",
          source: { kind: "system" },
          content:
            "User's deploy command is `pnpm deploy:prod` — they confirmed this is the canonical way to ship the api service.",
          tags: ["seeded"],
        });
        const unused = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: new Date(seedTime).toISOString().slice(0, 10),
          priority: "high",
          source: { kind: "system" },
          content:
            "User mentioned their cat is named Pixel and is a 3-year-old tabby. Unrelated to any technical work.",
          tags: ["seeded"],
        });

        // Backdate both so the only thing that can move them in the
        // ranking is a lastUsedAt bump from the observer pass.
        await fixture.db.query(
          "UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = ANY($2::text[])",
          [seedTime, [kept.id, unused.id]],
        );

        // Freeze the pack against the current session so the observer
        // sees both memories with their `[memory id: ...]` markers.
        const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);
        await rebuildMemoryContextPack({
          db: fixture.db,
          cache: fixture.cache,
          settings,
          sessionId: "session_eval",
        });

        const messages: AgentMessage[] = [
          {
            role: "user",
            content: [{ type: "text", text: "How do I deploy the api?" }],
            timestamp: Date.now(),
          },
          createAssistantMessage({
            text: "Run `pnpm deploy:prod` — that's the canonical command you confirmed earlier for shipping the api service.",
            timestamp: Date.now() + 1,
          }),
        ];

        await updateObservationalMemory({
          db: fixture.db,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          messages,
        });

        const refreshedKept = await fetchById(fixture.db, kept.id);
        const refreshedUnused = await fetchById(fixture.db, unused.id);

        // Kept marker should be bumped to roughly "now" (within the
        // duration of this test). Unused marker should still match its
        // backdated seed time.
        const now = Date.now();
        expect(refreshedKept.lastUsedAt).toBeGreaterThan(seedTime + 60_000);
        expect(refreshedKept.lastUsedAt).toBeLessThanOrEqual(now);
        expect(refreshedUnused.lastUsedAt).toBe(seedTime);

        // Concrete proof of re-ranking: rebuild the pack and verify the
        // kept marker now precedes the unused marker. With identical
        // priority+kind and only the kept marker bumped, this ordering
        // is the direct consequence of the lastUsedAt update.
        await rebuildMemoryContextPack({
          db: fixture.db,
          cache: fixture.cache,
          settings,
          sessionId: "session_eval",
        });
        const pack = fixture.cache.getContextPack();
        const ids = pack.global.map((row) => row.id);
        expect(ids).toContain(kept.id);
        expect(ids).toContain(unused.id);
        expect(ids.indexOf(kept.id)).toBeLessThan(ids.indexOf(unused.id));
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});

async function fetchById(
  db: Awaited<ReturnType<typeof createMemoryFixture>>["db"],
  id: string,
): Promise<{ lastUsedAt: number; createdAt: number }> {
  const result = await db.query<{ created_at: number; last_used_at: number }>(
    "SELECT created_at, last_used_at FROM observations WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`No observation with id ${id}`);
  return { createdAt: row.created_at, lastUsedAt: row.last_used_at };
}
