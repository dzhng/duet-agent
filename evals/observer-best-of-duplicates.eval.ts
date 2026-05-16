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
 * Red/green eval: when several existing memories cover the SAME fact,
 * the observer should only bump `last_used_at` on the single best one —
 * not on every duplicate that happens to match.
 *
 * Without the "pick the best duplicate" instruction, the observer
 * happily cites every overlapping memory id, which uniformly refreshes
 * stale/vague duplicates and defeats the freshness-decay ranking.
 * The fix lives in the `usedObservationIds` section of
 * `observational-prompts.ts`.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

describe("observer bumps only the best duplicate memory", () => {
  testIfDocker(
    "with three overlapping memories about the same deploy command, only the best one's last_used_at advances",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        // Best memory: most specific, highest priority, most recent
        // wording. This is the one the observer should cite.
        const best = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "high",
          source: { kind: "system" },
          content:
            "User confirmed the canonical deploy command for the api service is `pnpm deploy:prod` (run from repo root, requires VPN).",
          tags: ["seeded", "best"],
        });
        // Duplicate: same fact, less specific. Should NOT be bumped.
        const dupMedium = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-15",
          priority: "medium",
          source: { kind: "system" },
          content: "User uses `pnpm deploy:prod` to ship the api service.",
          tags: ["seeded", "dup"],
        });
        // Duplicate: vague restatement. Should NOT be bumped.
        const dupVague = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-01",
          priority: "low",
          source: { kind: "system" },
          content: "User has a deploy command for the api service.",
          tags: ["seeded", "dup"],
        });
        // Unrelated decoy: must stay untouched.
        const cat = await fixture.append({
          sessionId: "session_other",
          kind: "reflection",
          observedDate: "2026-04-30",
          priority: "high",
          source: { kind: "system" },
          content: "User mentioned their cat is named Pixel and is a 3-year-old tabby.",
          tags: ["seeded"],
        });

        await rebuildMemoryContextPack({
          session: fixture.session,
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
            text: "Run `pnpm deploy:prod` from the repo root (VPN required) — the canonical deploy command you confirmed earlier.",
            timestamp: Date.now() + 1,
          }),
        ];

        const seedTime = Date.now() - 24 * 60 * 60 * 1000;
        const seededIds = [best.id, dupMedium.id, dupVague.id, cat.id];
        await fixture.session.withDb(async (db) => {
          await db.query(
            "UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = ANY($2::text[])",
            [seedTime, seededIds],
          );
        });

        await updateObservationalMemory({
          session: fixture.session,
          memory: fixture.cache,
          sessionId: "session_eval",
          effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
          actorModel: memoryModel,
          messages,
        });

        const rows = await readLastUsed(fixture.session, seededIds);

        // Best one moved.
        expect(rows[best.id]).toBeGreaterThan(seedTime + 60_000);
        // Duplicates stayed pinned at the seed time. This is the
        // contract: do not refresh every memory that overlaps the
        // same fact — only the single best representative.
        expect(rows[dupMedium.id]).toBe(seedTime);
        expect(rows[dupVague.id]).toBe(seedTime);
        // Unrelated decoy untouched.
        expect(rows[cat.id]).toBe(seedTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});

async function readLastUsed(
  session: Awaited<ReturnType<typeof createMemoryFixture>>["session"],
  ids: string[],
): Promise<Record<string, number>> {
  const result = await session.withDb(async (db) =>
    db.query<{ id: string; last_used_at: number }>(
      "SELECT id, last_used_at FROM observations WHERE id = ANY($1::text[])",
      [ids],
    ),
  );
  const out: Record<string, number> = {};
  for (const row of result?.rows ?? []) {
    out[row.id] = row.last_used_at;
  }
  return out;
}
