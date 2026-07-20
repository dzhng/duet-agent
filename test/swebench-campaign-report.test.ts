import { describe, expect, test } from "bun:test";

import type { CampaignConfigName } from "../benchmarks/swebench/src/config-override.js";
import {
  buildCampaignReport,
  campaignReportPassesAdmission,
  lintPatch,
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
    expect(report.configs["glm-pure"]).toMatchObject({
      costUsd: 0.75,
      executorCostUsd: 0,
      auxiliaryCostUsd: 0.75,
    });
    expect(renderCampaignReport(report)).toContain("Advisor-only wins: 1 (org__repo-2)");
  });

  test("patch lint rejects tests and runtime files from exact staged paths", () => {
    expect(
      lintPatch("diff", ["src/main.ts", "test/main.test.ts", ".duet/models.json"], 100),
    ).toEqual({
      paths: ["src/main.ts", "test/main.test.ts", ".duet/models.json"],
      violations: [
        "test file modified: test/main.test.ts",
        "runtime file leaked: .duet/models.json",
      ],
      admissionViolations: [
        "test file modified: test/main.test.ts",
        "runtime file leaked: .duet/models.json",
      ],
    });
  });

  test("reports an empty patch without failing the integrity assertion", () => {
    const patchLint = lintPatch("", [], 100);
    expect(patchLint).toEqual({
      paths: [],
      violations: ["patch is empty"],
      admissionViolations: [],
    });
    const entries = fixtureEntries().slice(0, 1);
    const attempts = fixtureAttempts(entries);
    attempts[0]!.patchLint = patchLint;
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false]])),
    );
    expect(report.patchAssertion).toEqual({ passed: true, violations: [] });
    expect(report.configs[attempts[0]!.config].patchViolations).toEqual([
      `${attempts[0]!.config}/org__repo-1: patch is empty`,
    ]);
  });

  test("fails patch integrity when artifact admission rejected the rollout", () => {
    const entries = fixtureEntries().slice(0, 1);
    const attempts = fixtureAttempts(entries);
    const rejected = attempts.find((attempt) => attempt.config === "kimi-fable-advisor")!;
    rejected.phase = "failed";
    rejected.failureKind = "patch";
    rejected.failureMessage = "Patch policy violation: test file modified: tests/tmp.test.js";
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false]])),
    );

    expect(report.patchAssertion).toEqual({
      passed: false,
      violations: [
        "kimi-fable-advisor/org__repo-1: Patch policy violation: test file modified: tests/tmp.test.js",
      ],
    });
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

  test("fails advised-arm attribution unless the intended advisor succeeds exactly once", () => {
    const entries = fixtureEntries().slice(0, 1);
    const attempts = fixtureAttempts(entries);
    const wrongAdvisor = attempts.find((attempt) => attempt.config === "kimi-fable-advisor")!
      .telemetry!.advisorCalls;
    wrongAdvisor.total = 1;
    wrongAdvisor.success = 1;
    wrongAdvisor.successByModel = { "moonshotai/kimi-k3": 1 };
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false]])),
    );

    expect(report.advisedAdvisorAssertion).toEqual({
      passed: false,
      violations: [
        "glm-kimi-advisor/org__repo-1: expected 1 successful moonshotai/kimi-k3 call; observed total=0, success=0, models={}",
        'kimi-fable-advisor/org__repo-1: expected 1 successful anthropic/claude-fable-5 call; observed total=1, success=1, models={"moonshotai/kimi-k3":1}',
      ],
    });
    expect(campaignReportPassesAdmission(report)).toBe(false);
  });

  test("lets the official scorer decide a budget-interrupted patch outcome", () => {
    const entries = fixtureEntries().slice(0, 1);
    const attempts = fixtureAttempts(entries);
    const interrupted = attempts.find((attempt) => attempt.config === "glm-pure")!;
    interrupted.terminalType = "interrupted";
    interrupted.telemetry!.terminalStatus = "interrupted";
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores([
        ["glm-pure", [true]],
        ["glm-kimi-advisor", [false]],
        ["kimi-pure", [false]],
        ["kimi-fable-advisor", [false]],
      ]),
    );

    expect(report.configs["glm-pure"].resolved).toBe(1);
    expect(report.comparisons[0]!.pureOnlyWins).toEqual(["org__repo-1"]);
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
