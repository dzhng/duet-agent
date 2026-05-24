import { describe, expect, test } from "bun:test";
import {
  OBSERVATION_BUFFER_RATIO,
  REFLECTION_BUFFER_RATIO,
  DEFAULT_EFFECTIVE_CONTEXT,
  deriveMemoryBudgets,
  FIXED_OBSERVER_BUDGETS,
  GLOBAL_CONTEXT_TOKEN_BUDGET,
  MEMORY_BUDGET_RATIOS,
  resolveObservationalMemorySettings,
  validateObservationalMemorySettings,
} from "../src/memory/observational.js";

/**
 * The local-session memory triggers and buffers all fall out of
 * `effectiveContext` via fixed ratios; the cross-session global pack uses
 * a separate fixed token cap (`GLOBAL_CONTEXT_TOKEN_BUDGET`). These tests
 * pin both surfaces so the README, the type docs, and the runtime
 * derivation cannot drift apart silently.
 */
describe("Memory budgets", () => {
  test("local-session ratios stay below 1.0 and global pack is a fixed 8k cap", () => {
    const total = MEMORY_BUDGET_RATIOS.messageTokens + MEMORY_BUDGET_RATIOS.observationTokens;
    // The two local-session ratios used to share `effectiveContext` with
    // the global pack so the three summed to 1. The global pack is now a
    // fixed cap, so the remaining ratios only need to leave headroom for
    // the system prompt and tool slack the raw tail absorbs.
    expect(total).toBeLessThan(1);
    expect(MEMORY_BUDGET_RATIOS.messageTokens).toBe(0.6);
    expect(MEMORY_BUDGET_RATIOS.observationTokens).toBe(0.325);
    expect(GLOBAL_CONTEXT_TOKEN_BUDGET).toBe(8_000);
  });

  test("deriveMemoryBudgets produces the documented numbers at the 200k default", () => {
    const budgets = deriveMemoryBudgets(DEFAULT_EFFECTIVE_CONTEXT);
    expect(budgets).toEqual({
      observation: {
        messageTokens: 120_000,
        maxTranscriptTokens: FIXED_OBSERVER_BUDGETS.maxTranscriptTokens,
        maxObservationLogTokens: FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
        bufferActivation: 60_000,
        previousObserverTokens: FIXED_OBSERVER_BUDGETS.previousObserverTokens,
      },
      reflection: {
        observationTokens: 65_000,
        bufferActivation: 26_000,
      },
      globalContextTokenBudget: GLOBAL_CONTEXT_TOKEN_BUDGET,
    });
  });

  test("globalContextTokenBudget is fixed across actor windows", () => {
    for (const effectiveContext of [50_000, 200_000, 1_000_000]) {
      const budgets = deriveMemoryBudgets(effectiveContext);
      expect(budgets.globalContextTokenBudget).toBe(GLOBAL_CONTEXT_TOKEN_BUDGET);
    }
  });

  test("globalContextTokenBudget clamps down on tiny effectiveContext", () => {
    // Test-mode fixtures sometimes pass effectiveContext smaller than the
    // global cap; the loader should never be told to pack more tokens than
    // the actor can hold.
    const budgets = deriveMemoryBudgets(2_000);
    expect(budgets.globalContextTokenBudget).toBe(2_000);
  });

  test("observer-only budgets are fixed regardless of effectiveContext", () => {
    const small = deriveMemoryBudgets(50_000);
    const large = deriveMemoryBudgets(1_000_000);
    expect(small.observation.maxTranscriptTokens).toBe(FIXED_OBSERVER_BUDGETS.maxTranscriptTokens);
    expect(small.observation.maxObservationLogTokens).toBe(
      FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
    );
    expect(small.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
    expect(large.observation.maxTranscriptTokens).toBe(FIXED_OBSERVER_BUDGETS.maxTranscriptTokens);
    expect(large.observation.maxObservationLogTokens).toBe(
      FIXED_OBSERVER_BUDGETS.maxObservationLogTokens,
    );
    expect(large.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
  });

  test("buffer activations match their per-pipeline ratios across scales", () => {
    for (const effectiveContext of [10_000, 200_000, 500_000]) {
      const budgets = deriveMemoryBudgets(effectiveContext);
      expect(budgets.observation.bufferActivation).toBe(
        Math.floor(OBSERVATION_BUFFER_RATIO * budgets.observation.messageTokens),
      );
      expect(budgets.reflection.bufferActivation).toBe(
        Math.floor(REFLECTION_BUFFER_RATIO * budgets.reflection.observationTokens),
      );
      expect(budgets.observation.bufferActivation).toBeLessThan(budgets.observation.messageTokens);
      expect(budgets.reflection.bufferActivation).toBeLessThan(
        budgets.reflection.observationTokens,
      );
    }
  });

  test("tiny effectiveContext still produces strictly positive budgets that pass validation", () => {
    // 2 is the smallest E where every ratio rounds down to at least 1
    // distinct from its trigger: messageTokens=1.2→1, buffer=0.5→1 would
    // tie; the atLeastOne floor keeps both at 1 only when the rounding
    // would collapse them. Validate the function with a small but
    // realistic test-mode value instead, which is what the test fixtures
    // pass when forcing compaction.
    const budgets = deriveMemoryBudgets(17);
    expect(budgets.observation.messageTokens).toBeGreaterThan(0);
    expect(budgets.observation.bufferActivation).toBeGreaterThan(0);
    expect(budgets.reflection.observationTokens).toBeGreaterThan(0);
    expect(budgets.reflection.bufferActivation).toBeGreaterThan(0);
    expect(budgets.globalContextTokenBudget).toBeGreaterThan(0);

    const settings = resolveObservationalMemorySettings(17);
    // Validation throws on `buffer >= trigger`; assert it does not.
    expect(() => validateObservationalMemorySettings(settings)).not.toThrow();
  });

  test("resolveObservationalMemorySettings merges derived budgets with user knobs", () => {
    const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT, {
      observation: { instruction: "always remember X" },
      reflection: { instruction: "always condense Y" },
      reflectionBias: 2,
      recencyHalfLifeMs: 1_000,
      retrieval: false,
    });

    // Derived numbers come from deriveMemoryBudgets unchanged.
    expect(settings.observation.messageTokens).toBe(120_000);
    expect(settings.reflection.observationTokens).toBe(65_000);
    expect(settings.globalContextTokenBudget).toBe(GLOBAL_CONTEXT_TOKEN_BUDGET);

    // User knobs flow through.
    expect(settings.observation.instruction).toBe("always remember X");
    expect(settings.reflection.instruction).toBe("always condense Y");
    expect(settings.reflectionBias).toBe(2);
    expect(settings.recencyHalfLifeMs).toBe(1_000);
    expect(settings.retrieval).toBe(false);
  });

  test("resolveObservationalMemorySettings defaults retrieval on and applies documented decay", () => {
    const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);
    expect(settings.retrieval).toBe(true);
    expect(settings.reflectionBias).toBe(1.3);
    expect(settings.recencyHalfLifeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
