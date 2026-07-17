import { describe, expect } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import corpusJson from "./fixtures/model-routing/golden-prompts.json" with { type: "json" };
import { testIfDocker } from "../test/helpers/docker-only.js";
import { classifyRoute } from "../src/model-routing/classifier.js";
import { CLASSIFIER_PROMPT_VERSION } from "../src/model-routing/prompts.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

interface GoldenCase {
  id: string;
  prompt: string;
  tier: string;
  hasImages?: boolean;
  expectedRoute: string | string[];
  note?: string;
  currentTarget?: string;
  assistantSummaryHint?: string;
  toolNamesHint?: string;
  pair?: string;
  core?: boolean;
}

interface CaseResult {
  fixture: GoldenCase;
  trial: number;
  expected: string[];
  actual: string;
  rationale: string;
  latencyMs: number;
  usage?: Usage;
  error?: string;
}

const corpus = corpusJson as GoldenCase[];
const classifierModel = process.env.EVAL_MODEL ?? "gpt-5.6-luna";
const trials = Number(process.env.ROUTING_TRIALS ?? "3");
const caseFilter = process.env.ROUTING_CASE;
const hintStyle = process.env.ROUTING_HINT_STYLE ?? "summary";
const MAX_CLASSIFIER_INPUT_TOKENS = 1_000;
// Sanity bound only. The original frozen ceiling (1600ms, measured p50 1332ms) proved
// provider-variance flaky: later same-code runs measured p50 1856-2743ms on the Vercel
// gateway with correctness still 100%. Gateway latency is not this eval's contract —
// the recorded p50/p95 in the scorecard output is the tracking signal; this assertion
// only catches pathological regressions (e.g. accidental full-transcript input).
const P50_LATENCY_CEILING_MS = 5_000;

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function expectedRoutes(fixture: GoldenCase): string[] {
  return Array.isArray(fixture.expectedRoute) ? fixture.expectedRoute : [fixture.expectedRoute];
}

function prevTurnHint(fixture: GoldenCase): string | undefined {
  if (hintStyle === "summary") return fixture.assistantSummaryHint;
  if (hintStyle === "tools") return fixture.toolNamesHint;
  throw new Error(`Unknown ROUTING_HINT_STYLE "${hintStyle}"; use summary or tools.`);
}

function classifierInputTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function logFailure(result: CaseResult): void {
  console.error(
    JSON.stringify(
      {
        id: result.fixture.id,
        trial: result.trial,
        expected: result.expected,
        actual: result.actual,
        rationale: result.rationale,
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        hintStyle,
        latencyMs: result.latencyMs,
        tokens: result.usage?.totalTokens ?? 0,
        inputTokens: classifierInputTokens(result.usage),
        error: result.error,
      },
      null,
      2,
    ),
  );
}

describe("model-routing classifier scorecard", () => {
  testIfDocker(
    "meets route accuracy, continuity, vision, input-size, and latency gates",
    async () => {
      expect(trials).toBeGreaterThan(0);
      const fixtures =
        caseFilter === "hint"
          ? corpus.filter((fixture) => fixture.core)
          : caseFilter
            ? corpus.filter((fixture) => fixture.id === caseFilter || fixture.pair === caseFilter)
            : corpus;
      expect(fixtures.length, `No golden cases matched ROUTING_CASE=${caseFilter}`).toBeGreaterThan(
        0,
      );

      const results: CaseResult[] = [];
      for (let trial = 1; trial <= trials; trial += 1) {
        for (const fixture of fixtures) {
          const tier = BUILT_IN_ROUTING_TABLE.tiers[fixture.tier];
          if (!tier) throw new Error(`Unknown fixture tier ${fixture.tier}`);
          const expected = expectedRoutes(fixture);
          const input = {
            tierName: fixture.tier,
            tier,
            guidance: BUILT_IN_ROUTING_TABLE.classifier.guidance,
            currentTarget: fixture.currentTarget,
            prevTurnHint: prevTurnHint(fixture),
            lastStepDelta: fixture.prompt,
            hasImages: fixture.hasImages ?? false,
            trigger: fixture.currentTarget ? ("cadence" as const) : ("turn_start" as const),
          };
          let usage: Usage | undefined;
          const startedAt = performance.now();
          try {
            const decision = await classifyRoute(input, {
              model: classifierModel,
              onUsage: (nextUsage) => {
                usage = nextUsage;
              },
            });
            results.push({
              fixture,
              trial,
              expected,
              actual: decision.route,
              rationale: decision.rationale,
              latencyMs: Math.round(performance.now() - startedAt),
              usage,
            });
          } catch (error) {
            results.push({
              fixture,
              trial,
              expected,
              actual: "<classification-error>",
              rationale: "No classifier decision returned.",
              latencyMs: Math.round(performance.now() - startedAt),
              usage,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const failures = results.filter((result) => !result.expected.includes(result.actual));
      for (const failure of failures) logFailure(failure);

      const hardInvariantFailures = results.filter((result) => {
        const tier = BUILT_IN_ROUTING_TABLE.tiers[result.fixture.tier]!;
        const invented = !Object.hasOwn(tier.routes, result.actual);
        const violatesVisionGuard = result.fixture.hasImages && result.actual !== tier.visionRoute;
        return invented || violatesVisionGuard;
      });
      const coreFailures = failures.filter((result) => result.fixture.core);
      const familyResults = new Map<string, CaseResult[]>();
      for (const result of results) {
        const family = result.expected[0]!;
        familyResults.set(family, [...(familyResults.get(family) ?? []), result]);
      }
      const familyAccuracy = Object.fromEntries(
        [...familyResults].map(([family, familyCases]) => [
          family,
          familyCases.filter((result) => result.expected.includes(result.actual)).length /
            familyCases.length,
        ]),
      );
      const latencies = results.map((result) => result.latencyMs);
      const totalTokens = results.reduce(
        (sum, result) => sum + (result.usage?.totalTokens ?? 0),
        0,
      );
      const totalCostUsd = results.reduce(
        (sum, result) => sum + (result.usage?.cost.total ?? 0),
        0,
      );
      const scorecard = {
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        classifierModel,
        hintStyle,
        cases: fixtures.length,
        trials,
        overallAccuracy: (results.length - failures.length) / results.length,
        familyAccuracy,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95),
        maxInputTokens: Math.max(...results.map((result) => classifierInputTokens(result.usage))),
        totalTokens,
        totalCostUsd,
      };
      console.log(`MODEL ROUTING SCORECARD ${JSON.stringify(scorecard)}`);

      expect(hardInvariantFailures, "Every output must be a real route and image-safe").toEqual([]);
      expect(coreFailures, "All core continuity/transition cases must pass every trial").toEqual(
        [],
      );
      expect(scorecard.maxInputTokens).toBeLessThanOrEqual(MAX_CLASSIFIER_INPUT_TOKENS);
      if (!caseFilter) {
        expect(scorecard.overallAccuracy).toBeGreaterThanOrEqual(0.9);
        expect(scorecard.latencyP50Ms).toBeLessThanOrEqual(P50_LATENCY_CEILING_MS);
        for (const [family, accuracy] of Object.entries(familyAccuracy)) {
          expect(accuracy, `${family} route-family accuracy`).toBeGreaterThanOrEqual(0.8);
        }
      } else {
        expect(failures).toEqual([]);
      }
    },
    600_000,
  );
});
