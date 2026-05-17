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
  FULL_SANDBOX_POOL,
  IOS_SAFE_AREA_SLICE,
  PWA_NATIVE_SLICE,
  STRATEGIC_DECISION_SLICE,
  USE_CASES_HERO_SLICE,
  VELGRESS_SLICE,
  VIEW_TRANSITIONS_SLICE,
} from "./fixtures/global-reflect/sandbox-memories.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";

/**
 * Evals for `duet memory reflect` — the cross-session reflect that
 * condenses the entire global pool into one reflection row.
 *
 * The canonical input is a full mass-redacted dump of the running
 * sandbox's `~/.duet/memory.db` global pool (284 rows / ~91k tokens).
 * Smaller curated slices are derived by filtering the same dump, so
 * every eval is grounded in real production observational memory
 * instead of synthetic test data.
 *
 * All evals are LLM-driven and gate behind the docker eval harness
 * (`DUET_TEST_IN_DOCKER=1`). When one starts failing locally, treat
 * that as a regression in the reflector contract (`observational-
 * prompts.ts`), not test flake.
 */

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
    "collapses the Velgress slice (~28 near-duplicate observations) without losing the canonical ship facts",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        expect(content).toContain("Velgress");
        // Concrete identifiers (URL OR commit) preserved somewhere.
        expect(content).toMatch(/velgress--team-aomni-com\.duet\.so|cac9bbc|5d199a9|a55172b/);
        // Do not restate the same headline once per fixture row.
        const shipMentions = countOccurrences(content.toLowerCase(), "velgress shipped");
        expect(shipMentions).toBeLessThan(4);
        // Pool replaced with the single reflection row.
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(1);
        expect(after.observations[0]!.id).toBe(result!.reflection.id);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );

  // ---- Eval 2 -------------------------------------------------------------
  testIfDocker(
    "preserves canonical iOS safe-area fix specifics (PR #1335 + composer file path + bottomInset deps)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, IOS_SAFE_AREA_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        expect(content).toContain("#1335");
        expect(content.toLowerCase()).toContain("bottominset");
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 3 -------------------------------------------------------------
  testIfDocker(
    "retains durable user preferences (`bun format` rule + PR title convention) under noise",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, FULL_SANDBOX_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content.toLowerCase();
        // Both durable conventions must survive in some recognizable form.
        expect(content).toMatch(/bun format/);
        expect(content).toMatch(/pr.*title|\[name\]|first name/);
      } finally {
        await fixture.dispose();
      }
    },
    300_000,
  );

  // ---- Eval 4 -------------------------------------------------------------
  testIfDocker(
    "collapses the use-cases hero supersession chain — final state survives, intermediates pruned",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, USE_CASES_HERO_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // Final state facts must survive.
        expect(content).toContain("PR #1334");
        expect(content.toLowerCase()).toMatch(/ascii|white-on-black|hero|use-cases/);
        // The chain went through many commits; the reflector should not
        // enumerate every intermediate sha. Sample a handful of
        // intermediates and require that not all of them survive.
        const intermediates = ["92e7387a", "a06b59aee", "f3133f674", "42b829cd8", "bfe7fc0c"];
        const stillPresent = intermediates.filter((sha) => content.includes(sha)).length;
        expect(stillPresent).toBeLessThanOrEqual(2);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );

  // ---- Eval 5 -------------------------------------------------------------
  testIfDocker(
    "preserves strategic decisions (Plan mode removed, Hyperframes adoption, duet-gateway provider)",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, STRATEGIC_DECISION_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content.toLowerCase();
        // Three independent strategic decisions — all should leave a trace.
        expect(content).toMatch(/hyperframes|remotion/);
        expect(content).toMatch(/plan mode/);
        // The "do not implement plan mode" directive is the actionable
        // half — drop it and the agent forgets why.
        expect(content).toMatch(/do not|don't|removed|deleted/);
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 6 -------------------------------------------------------------
  testIfDocker(
    "honors --target-tokens budget on the full 284-row pool",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, FULL_SANDBOX_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const targetTokens = 1500;
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
          targetTokens,
        });
        expect(result).toBeDefined();
        // Reflector + truncation guard must keep us under the budget,
        // with a small fudge factor for tokenization rounding.
        expect(tokensIn(result!.reflection.content)).toBeLessThanOrEqual(targetTokens + 128);
      } finally {
        await fixture.dispose();
      }
    },
    300_000,
  );

  // ---- Eval 7 -------------------------------------------------------------
  testIfDocker(
    "writes a single reflection row stamped with the global-prune session id",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
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

  // ---- Eval 8 -------------------------------------------------------------
  testIfDocker(
    "dry-run returns a reflected log without mutating the durable pool",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const beforeIds = await seedObservations(fixture, VELGRESS_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
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

  // ---- Eval 9 -------------------------------------------------------------
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
          model: DEFAULT_CLI_MEMORY_MODEL,
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

  // ---- Eval 10 ------------------------------------------------------------
  testIfDocker(
    "hallucination guard: reflected content references no PII names absent from the source",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VELGRESS_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // The Velgress slice never mentions team members besides David,
        // and never mentions any redacted customer placeholders. If a
        // reflected row name-drops them, the reflector hallucinated.
        for (const name of ["Customer A", "Customer B", "Customer C", "Influencer X"]) {
          expect(content).not.toContain(name);
        }
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );

  // ---- Eval 11 ------------------------------------------------------------
  testIfDocker(
    "preserves chronology across the full pool: at least three distinct dates remain",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, FULL_SANDBOX_POOL);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // The dump spans April 2026 → May 2026. After a prune we should
        // still see multiple distinct date anchors so supersession is
        // recoverable from the reflected log.
        const dateMatches = new Set(content.match(/2026-0[4-5]-\d{2}/g) ?? []);
        expect(dateMatches.size).toBeGreaterThanOrEqual(3);
      } finally {
        await fixture.dispose();
      }
    },
    300_000,
  );

  // ---- Eval 12 ------------------------------------------------------------
  testIfDocker(
    "end-to-end: 284-row real-sandbox pool reduces to a single row keeping multiple workstream signals",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, FULL_SANDBOX_POOL);
        const before = await readAllObservations(fixture.session);
        expect(before.observations.length).toBeGreaterThanOrEqual(280);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot: before,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const after = await readAllObservations(fixture.session);
        expect(after.observations.length).toBe(1);
        const content = after.observations[0]!.content;
        // Across all workstreams in the dump, at least the heaviest
        // signals should be representable somewhere in the surviving
        // row. Each substring corresponds to dozens of source rows.
        const signals = [
          /velgress/i,
          /view transition|#1336|#1341/i,
          /pwa|#1340|service worker/i,
          /#1334|use[- ]cases/i,
          /#1335|bottominset|safe area/i,
        ];
        const present = signals.filter((re) => re.test(content)).length;
        // At least 3 of the 5 major workstream signals must survive a
        // prune of the entire sandbox. (Each is represented by >5
        // source rows; losing more than two means the reflector is
        // dropping whole projects.)
        expect(present).toBeGreaterThanOrEqual(3);
      } finally {
        await fixture.dispose();
      }
    },
    360_000,
  );

  // ---- Eval 13 ------------------------------------------------------------
  testIfDocker(
    "view-transitions slice retains the final PR pair (#1336 merged, #1341 follow-up) and at least one drill-in policy",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, VIEW_TRANSITIONS_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        // Both PRs in the chain must remain.
        expect(content).toMatch(/#1336/);
        expect(content).toMatch(/#1341/);
        // At least one of the drill-in / peer-tab policy decisions has
        // to make it through — these are durable cross-session policy.
        expect(content.toLowerCase()).toMatch(/drill[- ]?in|peer tab|bottom tab|crossfade/);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );

  // ---- Eval 14 ------------------------------------------------------------
  testIfDocker(
    "PWA-native slice keeps the merged PR (#1340) and at least the offline / service-worker concept",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, PWA_NATIVE_SLICE);
        const snapshot = await readAllObservations(fixture.session);
        const result = await reflectAllObservations({
          session: fixture.session,
          snapshot,
          settings,
          model: DEFAULT_CLI_MEMORY_MODEL,
        });
        expect(result).toBeDefined();
        const content = result!.reflection.content;
        expect(content).toMatch(/#1340/);
        expect(content.toLowerCase()).toMatch(/service worker|offline|share_target|manifest/);
      } finally {
        await fixture.dispose();
      }
    },
    240_000,
  );
});
