import { readFile } from "node:fs/promises";

import type { RolloutAttempt, RolloutFailureKind } from "./artifacts.js";
import type { CampaignConfigName } from "./config-override.js";
import type { ManifestEntry } from "./manifest.js";
import { lintPatch, type PatchLint } from "./patch-policy.js";
import { parseScoringModelName, type ScoringIdentity } from "./scoring-identity.js";
import {
  normalizePersistedTelemetry,
  type AdvisorContextObservation,
  type RolloutTelemetry,
} from "./telemetry.js";

export { lintPatch, type PatchLint } from "./patch-policy.js";

export type OfficialStatus =
  | "resolved"
  | "unresolved"
  | "empty_patch"
  | "error"
  | "infra_error"
  | "missing";

/** One normalized official scorer row written by `score_predictions.py`. */
export interface OfficialScoreRow {
  instanceId: string;
  /** Canonical scorer model identity encoding the campaign config and trial. */
  model: string;
  status: OfficialStatus;
  error?: string;
}

/** Rollout evidence consumed by the pure report core. */
export interface ReportAttempt {
  instanceId: string;
  config: CampaignConfigName;
  /** One-based campaign repetition that produced this attempt. */
  trial: number;
  phase: "running" | "completed" | "failed";
  /** Classifies a failed attempt so reports keep model and infrastructure failures distinct. */
  failureKind?: RolloutFailureKind;
  /** Preserves the actionable failure detail written by the rollout artifact status. */
  failureMessage?: string;
  terminalType?: string;
  costUsd: number;
  telemetry?: RolloutTelemetry;
  patchLint?: PatchLint;
}

export interface ConfigReport {
  resolved: number;
  total: number;
  resolveRate: number;
  costUsd: number;
  executorCostUsd: number;
  auxiliaryCostUsd: number;
  advisorCalls: number;
  routerSwitches: Record<string, number>;
  failures: Record<string, number>;
  patchViolations: string[];
  byLanguage: Record<string, { resolved: number; total: number }>;
  /** Aggregate result for each one-based campaign repetition. */
  byTrial: TrialConfigReport[];
  /** Present only for advisor-enabled arms; it describes exposure without gating ITT. */
  consultation: ConfigConsultationReport | null;
}

/** Aggregate result for one repetition of a campaign configuration. */
export interface TrialConfigReport {
  /** One-based campaign repetition. */
  trial: number;
  /** Rollouts resolved in this repetition. */
  resolved: number;
  /** Manifest instances scheduled in this repetition. */
  total: number;
}

/** One instance repetition in a paired comparison bucket. */
export interface TrialResult {
  /** SWE-bench instance evaluated by both sides of the pair. */
  instanceId: string;
  /** One-based repetition shared by both sides of the pair. */
  trial: number;
}

export type PairedOutcome = "enabled_only" | "pure_only" | "both_resolve" | "neither_resolves";

export interface PairedOutcomeBuckets {
  /** Enabled arm resolved and paired pure arm did not. */
  enabledOnly: TrialResult[];
  /** Pure arm resolved and paired enabled arm did not. */
  pureOnly: TrialResult[];
  /** Both paired arms resolved. */
  bothResolve: TrialResult[];
  /** Neither paired arm resolved, including denominator-visible failures. */
  neitherResolves: TrialResult[];
}

export type ConsultationStatus = "successful" | "not_called" | "unsuccessful" | "missing_telemetry";

/** Per-instance exposure evidence retained alongside the primary randomized comparison. */
export interface ConsultationEvidenceReport {
  /** Manifest id that binds this evidence to one randomized pair. */
  instanceId: string;
  /** One-based repetition that binds this evidence to one randomized pair. */
  trial: number;
  /** Primary ITT outcome retained regardless of consultation status. */
  outcome: PairedOutcome;
  /** Whether the configured model actually returned advice on this enabled attempt. */
  status: ConsultationStatus;
  /** Concrete advisor model configured for this enabled arm. */
  expectedModel: string;
  /** Every advisor tool completion, including unsuccessful attempts. */
  totalCalls: number;
  /** Successful calls that returned the configured concrete advisor. */
  successfulExpectedModelCalls: number;
  /** Successful calls to another model, which do not enter the consultation subset. */
  successfulOtherModels: Record<string, number>;
  /** Cadence-gated attempts. */
  rateLimited: number;
  /** Attempts without an available advisor route. */
  unavailable: number;
  /** Tool errors or malformed successful-result details. */
  failed: number;
  /** Canonical parent-step indices for every advisor attempt. */
  callSteps: number[];
  /** First observable explicit edit/write step; null does not prove no shell mutation. */
  firstExplicitRepositoryMutationStep: number | null;
  /** Request-window provenance attached to successful calls. */
  context: ConsultationContextReport;
}

/** Context-fidelity evidence for successful tool calls on one enabled attempt. */
export interface ConsultationContextReport {
  /** Successful calls with complete structurally valid metadata. */
  valid: number;
  /** Successful calls whose details predate or omit context metadata. */
  missing: number;
  /** Successful calls whose context metadata has an invalid field shape. */
  malformed: number;
  /** Valid calls that omitted old messages to fit the real model window. */
  truncated: number;
  /** Parsed values retained for machine checks and report rendering. */
  observations: AdvisorContextObservation[];
}

export interface ConfigConsultationReport {
  /** Concrete advisor required for an attempt to enter the descriptive subset. */
  expectedModel: string;
  /** Enabled attempts with at least one successful expected-model call. */
  successfulAttempts: number;
  /** Enabled attempts where the executor never invoked the tool. */
  notCalledAttempts: number;
  /** Enabled attempts with calls but no successful expected-model response. */
  unsuccessfulAttempts: number;
  /** Enabled attempts lacking telemetry; distinct from a known zero-call attempt. */
  missingTelemetryAttempts: number;
  /** Sum of call-level advisor input estimates used for model-neutral comparison. */
  estimatedInputTokens: number;
  /** Provider-reported total tokens for the configured advisor model. */
  exactAdvisorTokens: number;
  /** Raw executor messages represented through observational compaction. */
  compactedMessages: number;
}

export interface ComparisonReport {
  /** Arm with the advisor tool disabled. */
  pure: CampaignConfigName;
  /** Paired arm with the normal product advisor package enabled. */
  enabled: CampaignConfigName;
  /** Primary intention-to-treat comparison; every manifest instance stays in this denominator. */
  intentionToTreat: PairedOutcomeBuckets;
  /**
   * Descriptive subset where the configured advisor actually returned advice. This is not a
   * randomized estimate and never replaces the intention-to-treat result.
   */
  successfulConsultationSubset: PairedOutcomeBuckets;
  /** One exposure row per instance repetition, including zero and unsuccessful calls. */
  consultationEvidence: ConsultationEvidenceReport[];
}

/** Machine-checkable paired campaign result. */
export interface CampaignReport {
  schemaVersion: 3;
  /** Number of manifest instances included in every configuration. */
  instanceCount: number;
  /** Number of scheduled repetitions for every instance and configuration. */
  trials: number;
  /** Results for exactly the arms scheduled by the campaign spec. */
  configs: Partial<Record<CampaignConfigName, ConfigReport>>;
  comparisons: ComparisonReport[];
  totalCostUsd: number;
  pureAdvisorAssertion: { passed: boolean; violations: string[] };
  /** Successful calls must prove which bounded executor context reached the advisor. */
  contextFidelityAssertion: { passed: boolean; violations: string[] };
  patchAssertion: { passed: boolean; violations: string[] };
}

/** Decide whether a scored campaign satisfies every experiment-admission invariant. */
export function campaignReportPassesAdmission(report: CampaignReport): boolean {
  return (
    report.pureAdvisorAssertion.passed &&
    report.contextFidelityAssertion.passed &&
    report.patchAssertion.passed
  );
}

const COMPARISONS: [CampaignConfigName, CampaignConfigName][] = [
  ["glm-pure", "glm-kimi-advisor"],
  ["kimi-pure", "kimi-fable-advisor"],
];

const EXPECTED_ADVISORS: Partial<Record<CampaignConfigName, string>> = {
  "glm-kimi-advisor": "moonshotai/kimi-k3",
  "kimi-fable-advisor": "anthropic/claude-fable-5",
};

/** Build paired statistics without excluding failed or missing outcomes. */
export function buildCampaignReport(
  entries: readonly ManifestEntry[],
  scheduledConfigs: readonly CampaignConfigName[],
  trials: number,
  attempts: readonly ReportAttempt[],
  scores: readonly OfficialScoreRow[],
): CampaignReport {
  if (!Number.isSafeInteger(trials) || trials < 1) {
    throw new Error("Report trials must be a positive integer.");
  }
  const scheduledConfigSet = new Set(scheduledConfigs);
  if (scheduledConfigs.length === 0 || scheduledConfigSet.size !== scheduledConfigs.length) {
    throw new Error("Report configs must be a non-empty unique list.");
  }
  const instanceIds = new Set(entries.map((entry) => entry.instanceId));
  if (instanceIds.size !== entries.length) {
    throw new Error("Report manifest has duplicate instances.");
  }
  const scoreByKey = new Map<string, OfficialStatus>();
  for (const score of scores) {
    const identity = parseScoringModelName(score.model);
    assertScheduledRollout(
      scheduledConfigSet,
      instanceIds,
      trials,
      identity,
      score.instanceId,
      "official score",
    );
    setUnique(
      scoreByKey,
      rolloutKey(identity.config, score.instanceId, identity.trial),
      score.status,
      "score",
    );
  }
  const attemptByKey = new Map<string, ReportAttempt>();
  for (const attempt of attempts) {
    assertScheduledRollout(
      scheduledConfigSet,
      instanceIds,
      trials,
      attempt,
      attempt.instanceId,
      "report attempt",
    );
    setUnique(
      attemptByKey,
      rolloutKey(attempt.config, attempt.instanceId, attempt.trial),
      attempt,
      "attempt",
    );
  }
  const configs: Partial<Record<CampaignConfigName, ConfigReport>> = {};
  const violations: string[] = [];
  const contextFidelityViolations: string[] = [];
  const patchViolations: string[] = [];

  for (const config of scheduledConfigs) {
    const configuredAdvisor = EXPECTED_ADVISORS[config];
    const summary: ConfigReport = {
      resolved: 0,
      total: entries.length * trials,
      resolveRate: 0,
      costUsd: 0,
      executorCostUsd: 0,
      auxiliaryCostUsd: 0,
      advisorCalls: 0,
      routerSwitches: {},
      failures: {},
      patchViolations: [],
      byLanguage: {},
      byTrial: Array.from({ length: trials }, (_, index) => ({
        trial: index + 1,
        resolved: 0,
        total: entries.length,
      })),
      consultation: configuredAdvisor ? emptyConfigConsultation(configuredAdvisor) : null,
    };
    for (let trial = 1; trial <= trials; trial += 1) {
      for (const entry of entries) {
        const result = { instanceId: entry.instanceId, trial };
        const label = `${config}/${formatTrialResult(result, trials)}`;
        const attempt = attemptByKey.get(rolloutKey(config, entry.instanceId, trial));
        const status = scoreByKey.get(rolloutKey(config, entry.instanceId, trial)) ?? "missing";
        const language = (summary.byLanguage[entry.language] ??= { resolved: 0, total: 0 });
        language.total += 1;
        if (status === "resolved" && hasCompletedArtifact(attempt)) {
          summary.resolved += 1;
          summary.byTrial[trial - 1]!.resolved += 1;
          language.resolved += 1;
        } else {
          increment(summary.failures, attempt?.failureKind ?? status);
        }
        summary.costUsd += attempt?.costUsd ?? 0;
        const executorCost = executorCostUsd(config, attempt?.telemetry);
        summary.executorCostUsd += executorCost;
        summary.auxiliaryCostUsd += (attempt?.costUsd ?? 0) - executorCost;
        summary.advisorCalls += attempt?.telemetry?.advisorCalls.total ?? 0;
        for (const [switchName, count] of Object.entries(
          attempt?.telemetry?.routerSwitches ?? {},
        )) {
          increment(summary.routerSwitches, switchName, count);
        }
        if (config.endsWith("-pure")) {
          if (!attempt?.telemetry) {
            violations.push(`${label}: missing telemetry`);
          } else if (attempt.telemetry.advisorCalls.total !== 0) {
            violations.push(label);
          }
        }
        collectContextFidelityViolations(label, attempt, contextFidelityViolations);
        const expectedAdvisor = EXPECTED_ADVISORS[config];
        if (expectedAdvisor) {
          const evidence = consultationEvidence(
            entry.instanceId,
            trial,
            "neither_resolves",
            expectedAdvisor,
            attempt,
          );
          if (!summary.consultation) {
            throw new Error(`Advisor-enabled config has no consultation summary: ${config}.`);
          }
          incrementConsultationSummary(summary.consultation, evidence, attempt?.telemetry);
        }
        if (attempt?.failureKind === "patch") {
          patchViolations.push(
            `${label}: ${attempt.failureMessage ?? "patch artifact admission failed"}`,
          );
        }
        for (const violation of attempt?.patchLint?.violations ?? []) {
          summary.patchViolations.push(`${label}: ${violation}`);
        }
        for (const violation of attempt?.patchLint?.admissionViolations ?? []) {
          patchViolations.push(`${label}: ${violation}`);
        }
      }
    }
    summary.resolveRate = summary.total === 0 ? 0 : summary.resolved / summary.total;
    configs[config] = summary;
  }

  const comparisons = COMPARISONS.filter(
    ([pure, enabled]) => scheduledConfigSet.has(pure) && scheduledConfigSet.has(enabled),
  ).map(([pure, enabled]) => {
    const expectedAdvisor = EXPECTED_ADVISORS[enabled];
    if (!expectedAdvisor)
      throw new Error(`Advisor-enabled config has no expected model: ${enabled}.`);
    const comparison: ComparisonReport = {
      pure,
      enabled,
      intentionToTreat: emptyOutcomeBuckets(),
      successfulConsultationSubset: emptyOutcomeBuckets(),
      consultationEvidence: [],
    };
    for (let trial = 1; trial <= trials; trial += 1) {
      for (const entry of entries) {
        const result = { instanceId: entry.instanceId, trial };
        const pureKey = rolloutKey(pure, entry.instanceId, trial);
        const enabledKey = rolloutKey(enabled, entry.instanceId, trial);
        const pureResolved =
          scoreByKey.get(pureKey) === "resolved" && hasCompletedArtifact(attemptByKey.get(pureKey));
        const enabledResolved =
          scoreByKey.get(enabledKey) === "resolved" &&
          hasCompletedArtifact(attemptByKey.get(enabledKey));
        const outcome = pairedOutcome(pureResolved, enabledResolved);
        addOutcome(comparison.intentionToTreat, outcome, result);
        const evidence = consultationEvidence(
          entry.instanceId,
          trial,
          outcome,
          expectedAdvisor,
          attemptByKey.get(enabledKey),
        );
        comparison.consultationEvidence.push(evidence);
        if (evidence.status === "successful") {
          addOutcome(comparison.successfulConsultationSubset, outcome, result);
        }
      }
    }
    return comparison;
  });

  return {
    schemaVersion: 3,
    instanceCount: entries.length,
    trials,
    configs,
    comparisons,
    totalCostUsd: attempts.reduce((total, attempt) => total + attempt.costUsd, 0),
    pureAdvisorAssertion: { passed: violations.length === 0, violations },
    contextFidelityAssertion: {
      passed: contextFidelityViolations.length === 0,
      violations: contextFidelityViolations,
    },
    patchAssertion: { passed: patchViolations.length === 0, violations: patchViolations },
  };
}

/** Load the newest attempt evidence for each logical rollout. */
export async function loadReportAttempts(
  attempts: readonly RolloutAttempt[],
): Promise<ReportAttempt[]> {
  const newest = new Map<string, RolloutAttempt>();
  for (const attempt of attempts) {
    const key = rolloutKey(attempt.spec.config, attempt.spec.instanceId, attempt.spec.trial);
    const prior = newest.get(key);
    if (!prior || prior.status.attempt < attempt.status.attempt) newest.set(key, attempt);
  }
  return Promise.all(
    [...newest.values()].map(async (attempt) => {
      let telemetry: RolloutTelemetry | undefined;
      let patchLint: PatchLint | undefined;
      try {
        telemetry = normalizePersistedTelemetry(
          JSON.parse(await readFile(`${attempt.directory}/telemetry.json`, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (attempt.status.phase === "completed") {
        try {
          const [patch, paths] = await Promise.all([
            readFile(`${attempt.directory}/patch.diff`, "utf8"),
            readFile(`${attempt.directory}/patch-paths.json`, "utf8").then(
              (value) => JSON.parse(value) as string[],
            ),
          ]);
          patchLint = lintPatch(patch, paths, attempt.spec.limits.patchBytes);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          patchLint = {
            paths: [],
            violations: ["completed artifact is missing patch evidence"],
            admissionViolations: ["completed artifact is missing patch evidence"],
          };
        }
      }
      return {
        instanceId: attempt.spec.instanceId,
        config: attempt.spec.config,
        trial: attempt.spec.trial,
        phase: attempt.status.phase,
        ...(attempt.status.failureKind ? { failureKind: attempt.status.failureKind } : {}),
        ...(attempt.status.message ? { failureMessage: attempt.status.message } : {}),
        ...(attempt.status.terminalType ? { terminalType: attempt.status.terminalType } : {}),
        costUsd: attempt.status.costUsd ?? 0,
        ...(telemetry ? { telemetry } : {}),
        ...(patchLint ? { patchLint } : {}),
      };
    }),
  );
}

export function renderCampaignReport(report: CampaignReport): string {
  const lines = [
    "# SWE-bench Multilingual campaign report",
    "",
    `This is a signal-seeking n=${report.instanceCount} × ${report.trials} ${report.trials === 1 ? "trial" : "trials"} experiment, not a leaderboard estimate.`,
    "",
    "## Paired comparisons",
    "",
  ];
  for (const comparison of report.comparisons) {
    const itt = comparison.intentionToTreat;
    const consulted = comparison.successfulConsultationSubset;
    lines.push(
      `### ${comparison.pure} vs ${comparison.enabled}`,
      "",
      "Primary intention-to-treat result (advisor disabled vs enabled):",
      "",
      `- Enabled-only: ${itt.enabledOnly.length}${formatResults(itt.enabledOnly, report.trials)}`,
      `- Pure-only: ${itt.pureOnly.length}${formatResults(itt.pureOnly, report.trials)}`,
      `- Both resolve: ${itt.bothResolve.length}`,
      `- Neither resolves: ${itt.neitherResolves.length}`,
      "",
      "Successful-consultation subset (descriptive, not randomized, and not a replacement for ITT):",
      "",
      `- Enabled-only: ${consulted.enabledOnly.length}${formatResults(consulted.enabledOnly, report.trials)}`,
      `- Pure-only: ${consulted.pureOnly.length}${formatResults(consulted.pureOnly, report.trials)}`,
      `- Both resolve: ${consulted.bothResolve.length}`,
      `- Neither resolves: ${consulted.neitherResolves.length}`,
      "",
      "| Rollout | ITT outcome | Consultation | Context fidelity | Calls | Call steps | First explicit repository mutation |",
      "| --- | --- | --- | --- | ---: | --- | ---: |",
      ...comparison.consultationEvidence.map(
        (evidence) =>
          `| ${formatTrialResult(evidence, report.trials)} | ${formatOutcome(evidence.outcome)} | ${formatConsultation(evidence)} | ${formatContextFidelity(evidence.context)} | ${evidence.totalCalls} | ${formatSteps(evidence.callSteps)} | ${evidence.firstExplicitRepositoryMutationStep ?? "unknown"} |`,
      ),
      "",
    );
  }
  lines.push(
    "## Arm totals",
    "",
    "| Arm | Resolved | Rate | Cost | Executor | Auxiliary | Advisor calls |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [name, config] of Object.entries(report.configs)) {
    lines.push(
      `| ${name} | ${config.resolved}/${config.total} | ${(config.resolveRate * 100).toFixed(1)}% | $${config.costUsd.toFixed(2)} | $${config.executorCostUsd.toFixed(2)} | $${config.auxiliaryCostUsd.toFixed(2)} | ${config.advisorCalls} |`,
    );
  }
  lines.push(
    "",
    "## Advisor efficiency",
    "",
    "| Arm | Estimated advisor input | Exact advisor tokens | Compacted messages |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const [name, config] of Object.entries(report.configs)) {
    if (!config.consultation) continue;
    lines.push(
      `| ${name} | ${config.consultation.estimatedInputTokens} | ${config.consultation.exactAdvisorTokens} | ${config.consultation.compactedMessages} |`,
    );
  }
  if (report.trials > 1) {
    lines.push(
      "",
      "## Trial totals",
      "",
      "| Arm | Trial | Resolved | Rate |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const [name, config] of Object.entries(report.configs)) {
      for (const trial of config.byTrial) {
        const rate = trial.total === 0 ? 0 : trial.resolved / trial.total;
        lines.push(
          `| ${name} | ${trial.trial} | ${trial.resolved}/${trial.total} | ${(rate * 100).toFixed(1)}% |`,
        );
      }
    }
  }
  lines.push(
    "",
    `Total model spend: $${report.totalCostUsd.toFixed(2)}.`,
    `Pure-arm advisor assertion: ${report.pureAdvisorAssertion.passed ? "PASS" : `FAIL (${report.pureAdvisorAssertion.violations.join(", ")})`}.`,
    `Advisor context fidelity assertion: ${report.contextFidelityAssertion.passed ? "PASS" : `FAIL (${report.contextFidelityAssertion.violations.join(", ")})`}.`,
    `Patch integrity assertion: ${report.patchAssertion.passed ? "PASS" : `FAIL (${report.patchAssertion.violations.join(", ")})`}.`,
    "",
  );
  return lines.join("\n");
}

function emptyOutcomeBuckets(): PairedOutcomeBuckets {
  return { enabledOnly: [], pureOnly: [], bothResolve: [], neitherResolves: [] };
}

function pairedOutcome(pureResolved: boolean, enabledResolved: boolean): PairedOutcome {
  if (pureResolved && enabledResolved) return "both_resolve";
  if (pureResolved) return "pure_only";
  if (enabledResolved) return "enabled_only";
  return "neither_resolves";
}

function addOutcome(
  buckets: PairedOutcomeBuckets,
  outcome: PairedOutcome,
  result: TrialResult,
): void {
  if (outcome === "enabled_only") buckets.enabledOnly.push(result);
  else if (outcome === "pure_only") buckets.pureOnly.push(result);
  else if (outcome === "both_resolve") buckets.bothResolve.push(result);
  else buckets.neitherResolves.push(result);
}

function consultationEvidence(
  instanceId: string,
  trial: number,
  outcome: PairedOutcome,
  expectedModel: string,
  attempt: ReportAttempt | undefined,
): ConsultationEvidenceReport {
  const calls = attempt?.telemetry?.advisorCalls;
  const successfulExpectedModelCalls = calls?.successByModel[expectedModel] ?? 0;
  const successfulOtherModels = Object.fromEntries(
    Object.entries(calls?.successByModel ?? {}).filter(([model]) => model !== expectedModel),
  );
  const status: ConsultationStatus = !attempt?.telemetry
    ? "missing_telemetry"
    : calls.total === 0
      ? "not_called"
      : successfulExpectedModelCalls > 0
        ? "successful"
        : "unsuccessful";
  const context = consultationContext(calls);
  return {
    instanceId,
    trial,
    outcome,
    status,
    expectedModel,
    totalCalls: calls?.total ?? 0,
    successfulExpectedModelCalls,
    successfulOtherModels,
    rateLimited: calls?.rateLimited ?? 0,
    unavailable: calls?.unavailable ?? 0,
    failed: calls?.failed ?? 0,
    callSteps: calls?.attempts?.map((call) => call.step) ?? [],
    firstExplicitRepositoryMutationStep: calls?.firstExplicitRepositoryMutationStep ?? null,
    context,
  };
}

function consultationContext(
  calls: RolloutTelemetry["advisorCalls"] | undefined,
): ConsultationContextReport {
  const successfulAttempts = calls?.attempts?.filter((call) => call.outcome === "success") ?? [];
  const validAttempts = successfulAttempts.filter(
    (call) => call.contextStatus === "valid" && call.context,
  );
  const malformed = successfulAttempts.filter(
    (call) =>
      call.contextStatus === "malformed" || (call.contextStatus === "valid" && !call.context),
  ).length;
  const explicitMissing = successfulAttempts.filter(
    (call) => !call.contextStatus || call.contextStatus === "missing",
  ).length;
  const unlocatedSuccessfulCalls = Math.max(0, (calls?.success ?? 0) - successfulAttempts.length);
  return {
    valid: validAttempts.length,
    missing: explicitMissing + unlocatedSuccessfulCalls,
    malformed,
    truncated: validAttempts.filter((call) => call.context?.truncated).length,
    observations: validAttempts.flatMap((call) => (call.context ? [call.context] : [])),
  };
}

function collectContextFidelityViolations(
  label: string,
  attempt: ReportAttempt | undefined,
  violations: string[],
): void {
  const context = consultationContext(attempt?.telemetry?.advisorCalls);
  if (context.missing > 0) {
    violations.push(
      `${label}: ${context.missing} successful advisor call(s) missing context metadata`,
    );
  }
  if (context.malformed > 0) {
    violations.push(
      `${label}: ${context.malformed} successful advisor call(s) have malformed context metadata`,
    );
  }
}

function emptyConfigConsultation(expectedModel: string): ConfigConsultationReport {
  return {
    expectedModel,
    successfulAttempts: 0,
    notCalledAttempts: 0,
    unsuccessfulAttempts: 0,
    missingTelemetryAttempts: 0,
    estimatedInputTokens: 0,
    exactAdvisorTokens: 0,
    compactedMessages: 0,
  };
}

function incrementConsultationSummary(
  summary: ConfigConsultationReport,
  evidence: ConsultationEvidenceReport,
  telemetry: RolloutTelemetry | undefined,
): void {
  const status = evidence.status;
  if (status === "successful") summary.successfulAttempts += 1;
  else if (status === "not_called") summary.notCalledAttempts += 1;
  else if (status === "unsuccessful") summary.unsuccessfulAttempts += 1;
  else summary.missingTelemetryAttempts += 1;
  summary.estimatedInputTokens += evidence.context.observations.reduce(
    (total, observation) => total + observation.estimatedInputTokens,
    0,
  );
  summary.compactedMessages += evidence.context.observations.reduce(
    (total, observation) => total + (observation.compactedMessages ?? 0),
    0,
  );
  summary.exactAdvisorTokens +=
    telemetry?.usageByModel.find((entry) => entry.model === summary.expectedModel)?.usage
      .totalTokens ?? 0;
}

function formatOutcome(outcome: PairedOutcome): string {
  if (outcome === "enabled_only") return "enabled only";
  if (outcome === "pure_only") return "pure only";
  if (outcome === "both_resolve") return "both resolve";
  return "neither resolves";
}

function formatConsultation(evidence: ConsultationEvidenceReport): string {
  if (evidence.status === "successful") return `successful ${evidence.expectedModel}`;
  if (evidence.status === "not_called") return "not called";
  if (evidence.status === "missing_telemetry") return "missing telemetry";
  const outcomes = [
    evidence.rateLimited > 0 ? `${evidence.rateLimited} rate-limited` : "",
    evidence.unavailable > 0 ? `${evidence.unavailable} unavailable` : "",
    evidence.failed > 0 ? `${evidence.failed} failed` : "",
    Object.keys(evidence.successfulOtherModels).length > 0
      ? `wrong model ${JSON.stringify(evidence.successfulOtherModels)}`
      : "",
  ].filter(Boolean);
  return outcomes.length > 0 ? outcomes.join(", ") : "unsuccessful";
}

function formatContextFidelity(context: ConsultationContextReport): string {
  const parts: string[] = [];
  if (context.valid > 0) {
    const observation = context.observations[0];
    const window = observation ? formatContextObservation(observation) : "";
    parts.push(`${context.valid} valid${window}`);
  }
  if (context.truncated > 0) parts.push(`${context.truncated} truncated`);
  if (context.missing > 0) parts.push(`${context.missing} missing`);
  if (context.malformed > 0) parts.push(`${context.malformed} malformed`);
  return parts.length > 0 ? parts.join(", ") : "not applicable";
}

function formatContextObservation(observation: AdvisorContextObservation): string {
  const tokenBudget = observation.inputTargetTokens
    ? `${observation.estimatedInputTokens} estimated/${observation.inputTargetTokens} target/${observation.contextWindowTokens} window tokens`
    : `${observation.estimatedInputTokens}/${observation.contextWindowTokens} estimated tokens`;
  const compacted =
    observation.compactedMessages === undefined
      ? ""
      : `/${observation.compactedMessages} compacted`;
  return `, ${tokenBudget} (${observation.safetyMarginTokens} safety margin), ${observation.includedMessages} included${compacted}/${observation.omittedMessages} omitted messages, ${observation.attachedImages} images`;
}

function formatSteps(steps: readonly number[]): string {
  return steps.length > 0 ? steps.join(", ") : "none";
}

function formatResults(results: readonly TrialResult[], trials: number): string {
  return results.length > 0
    ? ` (${results.map((result) => formatTrialResult(result, trials)).join(", ")})`
    : "";
}

function hasCompletedArtifact(attempt: ReportAttempt | undefined): boolean {
  return attempt?.phase === "completed";
}

function executorCostUsd(
  config: CampaignConfigName,
  telemetry: RolloutTelemetry | undefined,
): number {
  const executor = config.startsWith("glm-") ? "glm-5.2" : "kimi-k3";
  return Object.entries(telemetry?.costUsdByModel ?? {}).reduce(
    (total, [model, cost]) =>
      total + (model === executor || model.endsWith(`/${executor}`) ? cost : 0),
    0,
  );
}

function increment(values: Record<string, number>, key: string, amount = 1): void {
  values[key] = (values[key] ?? 0) + amount;
}

function rolloutKey(config: CampaignConfigName, instanceId: string, trial: number): string {
  return `${config}\0${instanceId}\0${trial}`;
}

function assertScheduledRollout(
  scheduledConfigs: ReadonlySet<CampaignConfigName>,
  instanceIds: ReadonlySet<string>,
  trials: number,
  identity: ScoringIdentity,
  instanceId: string,
  kind: "report attempt" | "official score",
): void {
  if (!scheduledConfigs.has(identity.config)) {
    throw new Error(`${kind} references unscheduled config ${identity.config}.`);
  }
  if (!instanceIds.has(instanceId)) {
    throw new Error(`${kind} references unscheduled instance ${instanceId}.`);
  }
  if (!Number.isSafeInteger(identity.trial) || identity.trial < 1 || identity.trial > trials) {
    throw new Error(`${kind} references unscheduled trial ${identity.trial} for ${instanceId}.`);
  }
}

function setUnique<T>(map: Map<string, T>, key: string, value: T, kind: string): void {
  if (map.has(key)) throw new Error(`Duplicate ${kind} identity: ${key.replaceAll("\0", "/")}.`);
  map.set(key, value);
}

function formatTrialResult(result: TrialResult, trials: number): string {
  return `${result.instanceId}${trials === 1 ? "" : `/t${result.trial}`}`;
}
