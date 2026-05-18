import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { ATOMIC_REFLECTIONS, SUMMARY_REFLECTION } from "./fixtures/bumping/blob-vs-atomic.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture, type MemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * Live-observer evals for the SELECTION half of the usage-bumping
 * path: when the observer cites a memory and the global pool
 * contains both a broad summary reflection and narrow, unit-sized
 * siblings covering the same fact, only the atomic rows the turn
 * actually leaned on should have their `last_used_at` advance.
 *
 * Harness: full-observer (drives `updateObservationalMemory`
 * end-to-end against the live memory model). `applyUsageBumps` is
 * private, and the SELECTION logic includes both the observer
 * citing the correct ids and the bump applying only to those rows,
 * so the end-to-end path is the right level of test even though
 * it costs a live model call. The assertions land on stored
 * `last_used_at` values rather than on prompt output.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

async function readLastUsed(
  fixture: MemoryFixture,
): Promise<Map<string, { lastUsedAt: number; content: string }>> {
  const result = await fixture.session.withDb(async (db) =>
    db.query<{ id: string; last_used_at: number; content: string }>(
      "SELECT id, last_used_at, content FROM observations",
    ),
  );
  const out = new Map<string, { lastUsedAt: number; content: string }>();
  for (const row of result?.rows ?? []) {
    out.set(row.id, { lastUsedAt: row.last_used_at, content: row.content });
  }
  return out;
}

async function runObserverTurn(
  fixture: MemoryFixture,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  await rebuildMemoryContextPack({
    session: fixture.session,
    cache: fixture.cache,
    settings,
    sessionId,
  });

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
    createAssistantMessage({
      text: assistantText,
      timestamp: Date.now() + 1,
    }),
  ];

  await updateObservationalMemory({
    session: fixture.session,
    memory: fixture.cache,
    sessionId,
    effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
    actorModel: memoryModel,
    messages,
  });
}

describe("bump prefers the narrowest row that carries the cited fact", () => {
  testIfDocker(
    "bumps narrow siblings, not the broad summary, when both cover the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId, ...atomicIds] = await seedObservations(fixture, [
          SUMMARY_REFLECTION,
          ...ATOMIC_REFLECTIONS,
        ]);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(summaryId)?.lastUsedAt ?? 0;
        expect(seededTime).toBeGreaterThan(0);

        await runObserverTurn(
          fixture,
          "session_bump_atomic",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);

        // Atomic siblings covering the two cited facts must bump.
        const transientAtomic = atomicIds.find((id) => after.get(id)?.content.includes("v0.1.131"));
        const vitestAtomic = atomicIds.find((id) => after.get(id)?.content.includes("885746567"));
        expect(transientAtomic).toBeDefined();
        expect(vitestAtomic).toBeDefined();
        expect(after.get(transientAtomic!)!.lastUsedAt).toBeGreaterThan(seededTime);
        expect(after.get(vitestAtomic!)!.lastUsedAt).toBeGreaterThan(seededTime);

        // The summary row covers the same facts but is not the narrowest
        // sibling; the observer must prefer the narrow rows. At the very
        // least the summary's lastUsedAt must stay below any bumped row.
        const summaryLastUsed = after.get(summaryId)!.lastUsedAt;
        expect(summaryLastUsed).toBeLessThan(after.get(transientAtomic!)!.lastUsedAt);
        expect(summaryLastUsed).toBeLessThan(after.get(vitestAtomic!)!.lastUsedAt);
        expect(summaryLastUsed).toBe(seededTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "falls back to the summary row when no narrower row carries the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId] = await seedObservations(fixture, [SUMMARY_REFLECTION]);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(summaryId)!.lastUsedAt;

        await runObserverTurn(
          fixture,
          "session_bump_fallback",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);
        // No atomic siblings exist; the only row covering those facts
        // is the only row, so the bump lands on it.
        expect(after.get(summaryId)!.lastUsedAt).toBeGreaterThan(seededTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "multiple atomic citations all get bumped",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const atomicIds = await seedObservations(fixture, ATOMIC_REFLECTIONS);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(atomicIds[0]!)!.lastUsedAt;

        await runObserverTurn(
          fixture,
          "session_bump_multi",
          "Quick recap: what changed for transient Anthropic retries, bundled ripgrep, and the " +
            "memory-observation formatting?",
          "v0.1.131 made `Anthropic stream ended before message_stop` transient in " +
            "`src/turn-runner/transient-error.ts`. Bundled ripgrep ships via `@vscode/ripgrep` " +
            "optional platform deps and `withBundledRipgrep` is wired in `src/turn-runner/tools.ts`. " +
            "Memory-observation formatting (v0.1.130) now skips completed events when both " +
            "`observation` and `usageBumped` are empty, otherwise keeps the `Memory observation " +
            "recorded.` prefix with the optional `Reinforced N prior memor{y,ies}.` suffix.",
        );

        const after = await readLastUsed(fixture);
        const bumped = atomicIds.filter((id) => {
          const row = after.get(id);
          return row !== undefined && row.lastUsedAt > seededTime;
        });
        // Three distinct facts were cited; each should land on its
        // own atomic row, not collapse to a single bump.
        expect(bumped.length).toBeGreaterThanOrEqual(3);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});
