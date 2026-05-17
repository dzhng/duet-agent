import { describe, expect } from "bun:test";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  GLOBAL_REFLECTION_SESSION_ID,
  reflectAllObservations,
  resolveObservationalMemorySettings,
} from "../src/memory/observational.js";
import { readAllObservations } from "../src/memory/storage.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import {
  DURABLE_USER_FACTS,
  INBOX_NO_OP_DUPLICATES,
  IOS_SAFE_AREA_DUPLICATES,
  STRATEGIC_DECISIONS,
  SUPERSEDED_CHAIN,
  TENTATIVE_LOW_SIGNAL,
  VELGRESS_DUPLICATES,
} from "./fixtures/global-reflect/sandbox-memories.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";

/**
 * Evals for `duet memory reflect` — the cross-session reflect that
 * condenses the entire global pool into one reflection row. Fixtures
 * are real observations copied verbatim out of the Duet sandbox's
 * `~/.duet/memory.db`, grouped by the property under test.
 *
 * All evals are LLM-driven, so they only run inside the docker eval
 * harness (`DUET_TEST_IN_DOCKER=1`). Each one asserts a contract that
 * the reflector prompt is supposed to enforce — when an eval starts
 * failing locally, treat that as a regression in `observational-
 * prompts.ts`, not test flake.
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

function tokensIn(text: string): number {
  return Math.ceil(text.length / 4);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count++;
    from = index + needle.length;
  }
}

describe("duet memory reflect — global prune", () => {
  // ---- Eval 1 -------------------------------------------------------------
  testIfDocker(
    "collapses 8 near-duplicate Velgress 'shipped' observations into a single representative entry",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // The canonical ship facts must survive.
        expect(content).toContain("Velgress");
        // Concrete identifiers (URL, commit) preserved.
        expect(content).toMatch(/velgress--team-aomni-com\.duet\.so|cac9bbc/);
        // Reflected content must not restate the same ship line 8 times.
        const shipLines = countOccurrences(content.toLowerCase(), "velgress shipped");
        expect(shipLines).toBeLessThan(3);
        // Pool replaced with the single reflection row.
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(1);
        expect(after.observations[0]!.id).toBe(result!.reflection.id);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 2 -------------------------------------------------------------
  testIfDocker(
    "preserves the canonical iOS safe-area fix (PR #1335 + composer file path + bottomInset deps)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, IOS_SAFE_AREA_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // Concrete specifics must survive.
        expect(content).toContain("#1335");
        expect(content).toContain("apps/mobile/src/components/messages/composer/index.tsx");
        expect(content.toLowerCase()).toContain("bottominset");
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 3 -------------------------------------------------------------
  testIfDocker(
    "retains 🔴 durable user-identity facts (PR title format, bun format rule)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        // Mix durable user facts with a wall of low-signal duplicates so
        // the reflector is forced to choose what to keep.
        await seedObservations(fixture, [
          ...DURABLE_USER_FACTS,
          ...INBOX_NO_OP_DUPLICATES,
          ...TENTATIVE_LOW_SIGNAL,
        ]);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content.toLowerCase();
        // Both durable facts must survive in some recognizable form.
        expect(content).toMatch(/concise|opinionated|direct/);
        expect(content).toMatch(/pr.*title|\[name\]|first name/);
        expect(content).toMatch(/bun format/);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 4 -------------------------------------------------------------
  testIfDocker(
    "collapses 8 identical 'inbox empty, nothing to triage' cron entries to at most 1",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, INBOX_NO_OP_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content.toLowerCase();
        // Should not enumerate every single empty-inbox run.
        const inboxMentions = countOccurrences(content, "inbox was empty");
        expect(inboxMentions).toBeLessThanOrEqual(1);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 5 -------------------------------------------------------------
  testIfDocker(
    "supersession: only the final /use-cases hero round survives, intermediates pruned",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, SUPERSEDED_CHAIN);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // Final state's specifics must survive.
        expect(content).toContain("PR #1334");
        expect(content.toLowerCase()).toMatch(/ascii|white-on-black/);
        // Intermediate round commit shas should NOT all be enumerated.
        // At most one of the three intermediate commits should remain.
        const intermediates = ["92e7387a", "a06b59aee", "f3133f674"];
        const stillPresent = intermediates.filter((sha) => content.includes(sha)).length;
        expect(stillPresent).toBeLessThanOrEqual(1);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 6 -------------------------------------------------------------
  testIfDocker(
    "preserves strategic decisions (Hyperframes switch, plan-mode removal) verbatim enough",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, [...STRATEGIC_DECISIONS, ...TENTATIVE_LOW_SIGNAL]);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content.toLowerCase();
        expect(content).toMatch(/hyperframes|remotion/);
        expect(content).toMatch(/plan mode/);
        // The "do not implement plan mode" guidance is the actionable
        // half of the decision — drop it and the agent forgets why.
        expect(content).toMatch(/do not|don't|removed|deleted/);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 7 -------------------------------------------------------------
  testIfDocker(
    "honors the target-tokens budget (reflected log under requested cap)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, [
          ...VELGRESS_DUPLICATES,
          ...IOS_SAFE_AREA_DUPLICATES,
          ...SUPERSEDED_CHAIN,
          ...INBOX_NO_OP_DUPLICATES,
        ]);
        const targetTokens = 400;
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
          targetTokens,
        });
        expect(result).toBeDefined();
        // Reflector + truncation guard must keep us under the budget.
        // Allow a small fudge factor for tokenization rounding.
        expect(tokensIn(result!.reflection.content)).toBeLessThanOrEqual(targetTokens + 64);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 8 -------------------------------------------------------------
  testIfDocker(
    "writes a single reflection row stamped with the global-prune session id",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(1);
        const [row] = after.observations;
        expect(row!.sessionId).toBe(GLOBAL_REFLECTION_SESSION_ID);
        expect(row!.kind).toBe("reflection");
        expect(row!.tags).toContain("global-prune");
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 9 -------------------------------------------------------------
  testIfDocker(
    "dry-run returns a reflected log without mutating the durable pool",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const beforeIds = await seedObservations(fixture, VELGRESS_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
          dryRun: true,
        });
        expect(result).toBeDefined();
        expect(result!.written).toBe(false);
        expect(result!.reflection.content.length).toBeGreaterThan(0);
        const after = await readAllObservations(fixture.session);
        expect(after.observations.map((o) => o.id).sort()).toEqual([...beforeIds].sort());
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 10 ------------------------------------------------------------
  testIfDocker(
    "returns undefined and writes nothing when the store is empty",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeUndefined();
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(0);
      } finally {
        await fixture.dispose();
      }
    },
    30_000,
  );

  // ---- Eval 11 ------------------------------------------------------------
  testIfDocker(
    "does not invent details: reflected content references no names absent from the source",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_DUPLICATES);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // The Velgress fixtures never mention any of these people.
        // If a reflected row name-drops them, the reflector has
        // hallucinated context from the model's prior.
        for (const name of ["Ali", "Walter", "Ani", "Sawyer", "Janet", "Kamil"]) {
          expect(content).not.toContain(name);
        }
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 12 ------------------------------------------------------------
  testIfDocker(
    "preserves chronology: 2026-04 strategic decisions stay distinguishable from 2026-05 ones",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, STRATEGIC_DECISIONS);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // Both observed dates must still appear — chronology must
        // survive a prune so the agent can spot supersession.
        expect(content).toMatch(/2026-04-26|2026-04/);
        expect(content).toMatch(/2026-05-01|2026-05/);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 13 ------------------------------------------------------------
  testIfDocker(
    "end-to-end: mixed pool of 30+ observations reduces to a single row with key facts intact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, [
          ...VELGRESS_DUPLICATES,
          ...IOS_SAFE_AREA_DUPLICATES,
          ...DURABLE_USER_FACTS,
          ...SUPERSEDED_CHAIN,
          ...STRATEGIC_DECISIONS,
          ...INBOX_NO_OP_DUPLICATES,
          ...TENTATIVE_LOW_SIGNAL,
        ]);
        const before = await readAllObservations(fixture.session);
        expect(before.observations.length).toBeGreaterThanOrEqual(30);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: memoryModel,
        });
        expect(result).toBeDefined();
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(1);
        const content = after.observations[0]!.content;
        // The most-durable signals across all groups should each be
        // representable somewhere in the surviving row.
        expect(content).toContain("Velgress");
        expect(content).toContain("#1335");
        expect(content).toContain("#1334");
        expect(content.toLowerCase()).toMatch(/hyperframes|plan mode/);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );
});
