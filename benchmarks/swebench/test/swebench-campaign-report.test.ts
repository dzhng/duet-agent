import { describe, expect, test } from "bun:test";

import type { CampaignConfigName } from "../src/config-override.js";
import {
  buildCampaignReport,
  campaignReportPassesAdmission,
  lintPatch,
  renderCampaignReport,
  type OfficialScoreRow,
  type ReportAttempt,
} from "../src/report.js";
import type { ManifestEntry } from "../src/manifest.js";
import type { RolloutTelemetry } from "../src/telemetry.js";

const configs: CampaignConfigName[] = [
  "glm-pure",
  "glm-kimi-advisor",
  "kimi-pure",
  "kimi-fable-advisor",
];

describe("SWE-bench paired report", () => {
  test("keeps zero-call outcomes in ITT and attributes only observed consultations", () => {
    const entries = fixtureEntries();
    const attempts = fixtureAttempts(entries);
    const consulted = attempts.find(
      (attempt) => attempt.config === "glm-kimi-advisor" && attempt.instanceId === "org__repo-2",
    )!.telemetry!.advisorCalls;
    consulted.total = 1;
    consulted.success = 1;
    consulted.successByModel = { "moonshotai/kimi-k3": 1 };
    consulted.attempts = [successfulCall("moonshotai/kimi-k3")];
    const scores = fixtureScores([
      ["glm-pure", [true, false, true]],
      ["glm-kimi-advisor", [false, true, true]],
      ["kimi-pure", [false, false, false]],
      ["kimi-fable-advisor", [false, false, false]],
    ]);
    const report = buildCampaignReport(entries, attempts, scores);

    expect(report.comparisons[0]!.intentionToTreat).toEqual({
      enabledOnly: ["org__repo-2"],
      pureOnly: ["org__repo-1"],
      bothResolve: ["org__repo-3"],
      neitherResolves: [],
    });
    expect(report.comparisons[0]!.successfulConsultationSubset).toEqual({
      enabledOnly: ["org__repo-2"],
      pureOnly: [],
      bothResolve: [],
      neitherResolves: [],
    });
    expect(report.comparisons[0]!.consultationEvidence).toEqual([
      expect.objectContaining({
        instanceId: "org__repo-1",
        outcome: "pure_only",
        status: "not_called",
      }),
      expect.objectContaining({
        instanceId: "org__repo-2",
        outcome: "enabled_only",
        status: "successful",
      }),
      expect.objectContaining({
        instanceId: "org__repo-3",
        outcome: "both_resolve",
        status: "not_called",
      }),
    ]);
    expect(report.configs["glm-pure"]).toMatchObject({ resolved: 2, total: 3 });
    expect(report.configs["glm-pure"]).toMatchObject({
      costUsd: 0.75,
      executorCostUsd: 0,
      auxiliaryCostUsd: 0.75,
    });
    const markdown = renderCampaignReport(report);
    expect(markdown).toContain("Enabled-only: 1 (org__repo-2)");
    expect(markdown).toContain("org__repo-1 | pure only | not called");
    expect(markdown).not.toContain("Advisor-only");
    expect(markdown).not.toContain("bad advice");
    expect(report.contextFidelityAssertion).toEqual({ passed: true, violations: [] });
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

  test("surfaces wrong-model and unsuccessful calls without removing ITT outcomes", () => {
    const entries = fixtureEntries();
    const attempts = fixtureAttempts(entries);
    const enabledAttempts = attempts.filter((attempt) => attempt.config === "glm-kimi-advisor");
    const wrongAdvisor = enabledAttempts[0]!.telemetry!.advisorCalls;
    wrongAdvisor.total = 1;
    wrongAdvisor.success = 1;
    wrongAdvisor.successByModel = { "anthropic/claude-fable-5": 1 };
    wrongAdvisor.attempts = [successfulCall("anthropic/claude-fable-5")];
    const rateLimited = enabledAttempts[1]!.telemetry!.advisorCalls;
    rateLimited.total = 1;
    rateLimited.rateLimited = 1;
    const unavailable = enabledAttempts[2]!.telemetry!.advisorCalls;
    unavailable.total = 1;
    unavailable.unavailable = 1;
    attempts.find(
      (attempt) => attempt.config === "kimi-fable-advisor" && attempt.instanceId === "org__repo-1",
    )!.telemetry = undefined;
    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false, false, false]])),
    );

    expect(report.comparisons[0]!.intentionToTreat.neitherResolves).toEqual([
      "org__repo-1",
      "org__repo-2",
      "org__repo-3",
    ]);
    expect(report.comparisons[0]!.successfulConsultationSubset.neitherResolves).toEqual([]);
    expect(report.comparisons[0]!.consultationEvidence).toEqual([
      expect.objectContaining({
        instanceId: "org__repo-1",
        status: "unsuccessful",
        successfulOtherModels: { "anthropic/claude-fable-5": 1 },
      }),
      expect.objectContaining({
        instanceId: "org__repo-2",
        status: "unsuccessful",
        rateLimited: 1,
      }),
      expect.objectContaining({
        instanceId: "org__repo-3",
        status: "unsuccessful",
        unavailable: 1,
      }),
    ]);
    expect(report.comparisons[1]!.consultationEvidence[0]).toEqual(
      expect.objectContaining({ status: "missing_telemetry" }),
    );
    expect(campaignReportPassesAdmission(report)).toBe(true);
  });

  test("requires context provenance for successful calls but admits real-window truncation", () => {
    const entries = fixtureEntries();
    const attempts = fixtureAttempts(entries);
    const enabledAttempts = attempts.filter((attempt) => attempt.config === "glm-kimi-advisor");
    for (const attempt of enabledAttempts) {
      const calls = attempt.telemetry!.advisorCalls;
      calls.total = 1;
      calls.success = 1;
      calls.successByModel = { "moonshotai/kimi-k3": 1 };
    }
    enabledAttempts[0]!.telemetry!.advisorCalls.attempts = [
      successfulCallWithoutContext("moonshotai/kimi-k3", "missing"),
    ];
    enabledAttempts[1]!.telemetry!.advisorCalls.attempts = [
      successfulCallWithoutContext("moonshotai/kimi-k3", "malformed"),
    ];
    enabledAttempts[2]!.telemetry!.advisorCalls.attempts = [
      successfulCall("moonshotai/kimi-k3", { truncated: true, omittedMessages: 4 }),
    ];

    const report = buildCampaignReport(
      entries,
      attempts,
      fixtureScores(configs.map((config) => [config, [false, false, false]])),
    );

    expect(report.contextFidelityAssertion).toEqual({
      passed: false,
      violations: [
        "glm-kimi-advisor/org__repo-1: 1 successful advisor call(s) missing context metadata",
        "glm-kimi-advisor/org__repo-2: 1 successful advisor call(s) have malformed context metadata",
      ],
    });
    expect(report.comparisons[0]!.consultationEvidence[2]!.context).toEqual(
      expect.objectContaining({ valid: 1, truncated: 1, missing: 0, malformed: 0 }),
    );
    expect(renderCampaignReport(report)).toContain(
      "1 valid, 12000/262144 estimated tokens, 8 included/4 omitted messages, 1 images, 1 truncated",
    );
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
    expect(report.comparisons[0]!.intentionToTreat.pureOnly).toEqual(["org__repo-1"]);
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
    schemaVersion: 2,
    costUsdTotal: 0.25,
    costUsdByModel: { model: 0.25 },
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    usageByModel: [],
    advisorCalls: {
      total: 0,
      success: 0,
      rateLimited: 0,
      unavailable: 0,
      failed: 0,
      successByModel: {},
      firstExplicitRepositoryMutationStep: null,
      attempts: [],
    },
    routerSwitches: {},
    steps: 1,
    terminalStatus: "completed",
  };
}

function successfulCall(
  model: string,
  contextOverrides: Partial<
    NonNullable<RolloutTelemetry["advisorCalls"]["attempts"][number]["context"]>
  > = {},
): RolloutTelemetry["advisorCalls"]["attempts"][number] {
  return {
    step: 2,
    outcome: "success",
    model,
    contextStatus: "valid",
    context: {
      contextWindowTokens: 262144,
      reservedOutputTokens: 2048,
      inputLimitTokens: 259000,
      estimatedInputTokens: 12000,
      includedMessages: 8,
      omittedMessages: 0,
      truncated: false,
      attachedImages: 1,
      ...contextOverrides,
    },
    relativeToFirstExplicitRepositoryMutation: "before",
  };
}

function successfulCallWithoutContext(
  model: string,
  contextStatus: "missing" | "malformed",
): RolloutTelemetry["advisorCalls"]["attempts"][number] {
  return {
    step: 2,
    outcome: "success",
    model,
    contextStatus,
    relativeToFirstExplicitRepositoryMutation: "before",
  };
}
