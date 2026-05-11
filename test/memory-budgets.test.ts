import { describe, expect, test } from "bun:test";
import {
  BUFFER_RATIO,
  DEFAULT_EFFECTIVE_CONTEXT,
  deriveMemoryBudgets,
  FIXED_OBSERVER_BUDGETS,
  MEMORY_BUDGET_RATIOS,
  resolveObservationalMemorySettings,
  validateObservationalMemorySettings,
} from "../src/memory/observational.js";

/**
 * The whole memory budget surface is now one knob: every numeric trigger
 * and buffer falls out of `effectiveContext`. These tests pin the
 * documented ratios so the README, the type docs, and the runtime
 * derivation cannot drift apart silently.
 */
describe("Memory budgets", () => {
  test("actor-context ratios sum to 1.0 and global pack is 7.5 % of effectiveContext", () => {
    const total =
      MEMORY_BUDGET_RATIOS.messageTokens +
      MEMORY_BUDGET_RATIOS.observationTokens +
      MEMORY_BUDGET_RATIOS.globalContextTokenBudget;
    // Floating point: the three ratios are exact decimals chosen so the
    // sum equals 1 without rounding. If anyone shifts a ratio they must
    // also shift another to preserve the invariant.
    expect(total).toBe(1);
    expect(MEMORY_BUDGET_RATIOS.globalContextTokenBudget).toBe(0.075);
  });

  test("deriveMemoryBudgets produces the documented numbers at the 200k default", () => {
    const budgets = deriveMemoryBudgets(DEFAULT_EFFECTIVE_CONTEXT);
    expect(budgets).toEqual({
      observation: {
        messageTokens: 120_000,
        maxTokensPerBatch: FIXED_OBSERVER_BUDGETS.maxTokensPerBatch,
        bufferActivation: 60_000,
        previousObserverTokens: FIXED_OBSERVER_BUDGETS.previousObserverTokens,
      },
      reflection: {
        observationTokens: 65_000,
        bufferActivation: 32_500,
      },
      globalContextTokenBudget: 15_000,
    });
  });

  test("observer-only budgets are fixed regardless of effectiveContext", () => {
    const small = deriveMemoryBudgets(50_000);
    const large = deriveMemoryBudgets(1_000_000);
    expect(small.observation.maxTokensPerBatch).toBe(FIXED_OBSERVER_BUDGETS.maxTokensPerBatch);
    expect(small.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
    expect(large.observation.maxTokensPerBatch).toBe(FIXED_OBSERVER_BUDGETS.maxTokensPerBatch);
    expect(large.observation.previousObserverTokens).toBe(
      FIXED_OBSERVER_BUDGETS.previousObserverTokens,
    );
  });

  test("buffer activations are exactly BUFFER_RATIO of their triggers across scales", () => {
    for (const effectiveContext of [10_000, 200_000, 500_000]) {
      const budgets = deriveMemoryBudgets(effectiveContext);
      expect(budgets.observation.bufferActivation).toBe(
        Math.floor(BUFFER_RATIO * budgets.observation.messageTokens),
      );
      expect(budgets.reflection.bufferActivation).toBe(
        Math.floor(BUFFER_RATIO * budgets.reflection.observationTokens),
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
    expect(settings.globalContextTokenBudget).toBe(15_000);

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
