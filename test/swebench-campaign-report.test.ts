import { describe, expect, test } from "bun:test";

import type { CampaignConfigName } from "../benchmarks/swebench/src/config-override.js";
import {
  buildCampaignReport,
  renderCampaignReport,
  type OfficialScoreRow,
  type ReportAttempt,
} from "../benchmarks/swebench/src/report.js";
import type { ManifestEntry } from "../benchmarks/swebench/src/manifest.js";
import type { RolloutTelemetry } from "../benchmarks/swebench/src/telemetry.js";

const configs: CampaignConfigName[] = [
  "glm-pure",
  "glm-kimi-advisor",
  "kimi-pure",
  "kimi-fable-advisor",
];

describe("SWE-bench paired report", () => {
  test("keeps both discordant directions and every failed instance in the denominator", () => {
    const entries = fixtureEntries();
    const attempts = fixtureAttempts(entries);
    const scores = fixtureScores([
      ["glm-pure", [true, false, false]],
      ["glm-kimi-advisor", [false, true, false]],
      ["kimi-pure", [true, true, false]],
      ["kimi-fable-advisor", [true, false, false]],
    ]);
    const report = buildCampaignReport(entries, attempts, scores);

    expect(report.comparisons[0]).toMatchObject({
      advisorOnlyWins: ["org__repo-2"],
      pureOnlyWins: ["org__repo-1"],
      neitherResolves: ["org__repo-3"],
    });
    expect(report.comparisons[1]).toMatchObject({
      advisorOnlyWins: [],
      pureOnlyWins: ["org__repo-2"],
      bothResolve: ["org__repo-1"],
      neitherResolves: ["org__repo-3"],
    });
    expect(report.configs["glm-pure"]).toMatchObject({ resolved: 1, total: 3 });
    expect(renderCampaignReport(report)).toContain("Advisor-only wins: 1 (org__repo-2)");
  });

  test("fails the pure-arm assertion when telemetry contains an advisor call", () => {
    const entries = fixtureEntries().slice(0, 1);
    const attempts = fixtureAttempts(entries);
    attempts.find((attempt) => attempt.config === "kimi-pure")!.telemetry!.advisorCalls.total = 1;
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false]])),
    );
    expect(report.pureAdvisorAssertion).toEqual({
      passed: false,
      violations: ["kimi-pure/org__repo-1"],
    });
  });
});

function fixtureEntries(): ManifestEntry[] {
  return ["org__repo-1", "org__repo-2", "org__repo-3"].map((instanceId, index) => ({
    instanceId,
    language: (["Go", "Java", "Rust"] as const)[index]!,
    repo: "org/repo",
    baseCommit: `${index}`,
  }));
}

function fixtureAttempts(entries: readonly ManifestEntry[]): ReportAttempt[] {
  return entries.flatMap((entry) =>
    configs.map((config) => ({
      instanceId: entry.instanceId,
      config,
      phase: "completed" as const,
      terminalType: "complete",
      costUsd: 0.25,
      telemetry: emptyTelemetry(),
    })),
  );
}

function fixtureScores(
  values: readonly [CampaignConfigName, readonly boolean[]][],
): OfficialScoreRow[] {
  return values.flatMap(([config, outcomes]) =>
    outcomes.map((resolved, index) => ({
      instanceId: `org__repo-${index + 1}`,
      model: `duet-${config}`,
      status: resolved ? ("resolved" as const) : ("unresolved" as const),
    })),
  );
}

function emptyTelemetry(): RolloutTelemetry {
  return {
    costUsdTotal: 0.25,
    costUsdByModel: { model: 0.25 },
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    usageByModel: [],
    advisorCalls: {
      total: 0,
      success: 0,
      rateLimited: 0,
      unavailable: 0,
      successByModel: {},
    },
    routerSwitches: {},
    steps: 1,
    terminalStatus: "completed",
  };
}
