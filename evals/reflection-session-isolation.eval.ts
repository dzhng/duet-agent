import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { updateObservationalMemory } from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * Reflection must touch only the current session's rows. The
 * reflector reads its snapshot via `readSessionObservations(db,
 * sessionId)` and writes the result through
 * `replaceSessionObservations`, whose DELETE is scoped
 * `WHERE session_id = $1`. This eval drives the live reflector model
 * to fire a reflection in session B and asserts that session A's
 * rows survive byte-for-byte (id, content, last_used_at) so the
 * global pack stays intact.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

describe("reflection session isolation", () => {
  testIfDocker(
    "reflecting session B leaves session A's rows on disk untouched",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        // Two memories on session A. They must survive verbatim.
        const aDeploy = await fixture.append({
          sessionId: "session_a",
          kind: "reflection",
          observedDate: "2026-04-29",
          priority: "high",
          source: { kind: "system" },
          content:
            "User confirmed `pnpm deploy:prod` is the canonical deploy command for the api service.",
          tags: ["seeded"],
        });
        const aPet = await fixture.append({
          sessionId: "session_a",
          kind: "reflection",
          observedDate: "2026-04-29",
          priority: "high",
          source: { kind: "system" },
          content: "User mentioned their cat is named Pixel and is a 3-year-old tabby.",
          tags: ["seeded"],
        });

        // Backdate session A's lastUsedAt so we can detect any
        // unintended write activity on those rows.
        const aSeedTime = Date.now() - 24 * 60 * 60 * 1000;
        await fixture.db.query(
          "UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = ANY($2::text[])",
          [aSeedTime, [aDeploy.id, aPet.id]],
        );

        // Seed session B with enough observation content to trip the
        // reflection threshold on the next update pass. The threshold
        // is on `ceil(content.length / 4)`, so ~3.2k chars across
        // rows comfortably exceeds the 600-token cap below.
        for (let index = 0; index < 4; index++) {
          await fixture.append({
            sessionId: "session_b",
            kind: "observation",
            observedDate: "2026-05-08",
            priority: "medium",
            source: { kind: "system" },
            content: `Date: May 8, 2026 step-${index}-prefix-padding\n* \ud83d\udfe1 (10:0${index}) Working on feature ${"X".repeat(800)} step ${index} suffix details about file paths /var/log/app-${index}.log and metric value ${index * 137}`,
            tags: ["observational-memory"],
          });
        }

        // No new tail \u2014 observer has nothing to observe. Reflection
        // still fires because it checks session-local observation
        // tokens against the threshold regardless of observer output.
        const messages: AgentMessage[] = [];

        // E=2_000 → reflection.observationTokens≈650. The ~3.2k chars of
        // seeded session B content estimates to ~900 tokens, comfortably
        // clearing the trigger so reflection actually fires.
        const result = await updateObservationalMemory({
          db: fixture.db,
          memory: fixture.cache,
          sessionId: "session_b",
          effectiveContext: 2_000,
          actorModel: memoryModel,
          messages,
        });

        // Sanity: a reflection must actually have happened, otherwise
        // the assertions below would pass trivially.
        expect(result.reflections.length).toBe(1);
        expect(result.reflections[0]?.sessionId).toBe("session_b");

        // Session A rows survived: same ids, same content, same
        // last_used_at (no spurious bump).
        const aRows = await fixture.db.query<{
          id: string;
          content: string;
          last_used_at: number;
          session_id: string | null;
        }>(
          "SELECT id, content, last_used_at, session_id FROM observations WHERE session_id = $1 ORDER BY created_at ASC",
          ["session_a"],
        );
        expect(aRows.rows.map((row) => row.id)).toEqual([aDeploy.id, aPet.id]);
        expect(aRows.rows[0]?.content).toBe(aDeploy.content);
        expect(aRows.rows[1]?.content).toBe(aPet.content);
        expect(aRows.rows[0]?.last_used_at).toBe(aSeedTime);
        expect(aRows.rows[1]?.last_used_at).toBe(aSeedTime);

        // Session B rows: the four seeded observations were replaced
        // by exactly one reflection row.
        const bRows = await fixture.db.query<{ id: string; kind: string }>(
          "SELECT id, kind FROM observations WHERE session_id = $1",
          ["session_b"],
        );
        expect(bRows.rows.length).toBe(1);
        expect(bRows.rows[0]?.kind).toBe("reflection");
        expect(bRows.rows[0]?.id).toBe(result.reflections[0]?.id);

        // Total: 2 surviving session A rows + 1 session B reflection.
        const total = await fixture.db.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM observations",
        );
        expect(Number(total.rows[0]?.count)).toBe(3);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});
