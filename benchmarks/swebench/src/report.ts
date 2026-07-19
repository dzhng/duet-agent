import { readFile } from "node:fs/promises";

import type { RolloutAttempt, RolloutFailureKind } from "./artifacts.js";
import type { CampaignConfigName } from "./config-override.js";
import type { ManifestEntry } from "./manifest.js";
import type { RolloutTelemetry } from "./telemetry.js";

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
  model: string;
  status: OfficialStatus;
  error?: string;
}

/** Rollout evidence consumed by the pure report core. */
export interface ReportAttempt {
  instanceId: string;
  config: CampaignConfigName;
  phase: "running" | "completed" | "failed";
  failureKind?: RolloutFailureKind;
  terminalType?: string;
  costUsd: number;
  telemetry?: RolloutTelemetry;
  patchLint?: PatchLint;
}

export interface PatchLint {
  paths: string[];
  violations: string[];
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
}

export interface ComparisonReport {
  pure: CampaignConfigName;
  advised: CampaignConfigName;
  advisorOnlyWins: string[];
  pureOnlyWins: string[];
  bothResolve: string[];
  neitherResolves: string[];
}

/** Machine-checkable paired campaign result. */
export interface CampaignReport {
  schemaVersion: 1;
  configs: Record<CampaignConfigName, ConfigReport>;
  comparisons: ComparisonReport[];
  totalCostUsd: number;
  pureAdvisorAssertion: { passed: boolean; violations: string[] };
  patchAssertion: { passed: boolean; violations: string[] };
}

const COMPARISONS: [CampaignConfigName, CampaignConfigName][] = [
  ["glm-pure", "glm-kimi-advisor"],
  ["kimi-pure", "kimi-fable-advisor"],
];

/** Build paired statistics without excluding failed or missing outcomes. */
export function buildCampaignReport(
  entries: readonly ManifestEntry[],
  attempts: readonly ReportAttempt[],
  scores: readonly OfficialScoreRow[],
): CampaignReport {
  const scoreByKey = new Map(
    scores.map((score) => [`${configFromModel(score.model)}:${score.instanceId}`, score.status]),
  );
  const attemptByKey = new Map(
    attempts.map((attempt) => [`${attempt.config}:${attempt.instanceId}`, attempt]),
  );
  const configs = {} as Record<CampaignConfigName, ConfigReport>;
  const allConfigs: CampaignConfigName[] = [
    "glm-pure",
    "glm-kimi-advisor",
    "kimi-pure",
    "kimi-fable-advisor",
  ];
  const violations: string[] = [];
  const patchViolations: string[] = [];

  for (const config of allConfigs) {
    const summary: ConfigReport = {
      resolved: 0,
      total: entries.length,
      resolveRate: 0,
      costUsd: 0,
      executorCostUsd: 0,
      auxiliaryCostUsd: 0,
      advisorCalls: 0,
      routerSwitches: {},
      failures: {},
      patchViolations: [],
      byLanguage: {},
    };
    for (const entry of entries) {
      const key = `${config}:${entry.instanceId}`;
      const attempt = attemptByKey.get(key);
      const status = scoreByKey.get(key) ?? "missing";
      const language = (summary.byLanguage[entry.language] ??= { resolved: 0, total: 0 });
      language.total += 1;
      if (status === "resolved" && isAgentComplete(attempt)) {
        summary.resolved += 1;
        language.resolved += 1;
      } else {
        increment(summary.failures, attempt?.failureKind ?? status);
      }
      summary.costUsd += attempt?.costUsd ?? 0;
      const executorCost = executorCostUsd(config, attempt?.telemetry);
      summary.executorCostUsd += executorCost;
      summary.auxiliaryCostUsd += (attempt?.costUsd ?? 0) - executorCost;
      summary.advisorCalls += attempt?.telemetry?.advisorCalls.total ?? 0;
      for (const [switchName, count] of Object.entries(attempt?.telemetry?.routerSwitches ?? {})) {
        increment(summary.routerSwitches, switchName, count);
      }
      if (config.endsWith("-pure") && (attempt?.telemetry?.advisorCalls.total ?? 0) !== 0) {
        violations.push(`${config}/${entry.instanceId}`);
      }
      for (const violation of attempt?.patchLint?.violations ?? []) {
        const labelled = `${config}/${entry.instanceId}: ${violation}`;
        summary.patchViolations.push(labelled);
        patchViolations.push(labelled);
      }
    }
    summary.resolveRate = summary.total === 0 ? 0 : summary.resolved / summary.total;
    configs[config] = summary;
  }

  const comparisons = COMPARISONS.map(([pure, advised]) => {
    const comparison: ComparisonReport = {
      pure,
      advised,
      advisorOnlyWins: [],
      pureOnlyWins: [],
      bothResolve: [],
      neitherResolves: [],
    };
    for (const entry of entries) {
      const pureResolved =
        scoreByKey.get(`${pure}:${entry.instanceId}`) === "resolved" &&
        isAgentComplete(attemptByKey.get(`${pure}:${entry.instanceId}`));
      const advisedResolved =
        scoreByKey.get(`${advised}:${entry.instanceId}`) === "resolved" &&
        isAgentComplete(attemptByKey.get(`${advised}:${entry.instanceId}`));
      if (pureResolved && advisedResolved) comparison.bothResolve.push(entry.instanceId);
      else if (pureResolved) comparison.pureOnlyWins.push(entry.instanceId);
      else if (advisedResolved) comparison.advisorOnlyWins.push(entry.instanceId);
      else comparison.neitherResolves.push(entry.instanceId);
    }
    return comparison;
  });

  return {
    schemaVersion: 1,
    configs,
    comparisons,
    totalCostUsd: attempts.reduce((total, attempt) => total + attempt.costUsd, 0),
    pureAdvisorAssertion: { passed: violations.length === 0, violations },
    patchAssertion: { passed: patchViolations.length === 0, violations: patchViolations },
  };
}

/** Load the newest attempt evidence for each logical rollout. */
export async function loadReportAttempts(
  attempts: readonly RolloutAttempt[],
): Promise<ReportAttempt[]> {
  const newest = new Map<string, RolloutAttempt>();
  for (const attempt of attempts) {
    const key = `${attempt.spec.config}:${attempt.spec.instanceId}:t${attempt.spec.trial}`;
    const prior = newest.get(key);
    if (!prior || prior.status.attempt < attempt.status.attempt) newest.set(key, attempt);
  }
  return Promise.all(
    [...newest.values()].map(async (attempt) => {
      let telemetry: RolloutTelemetry | undefined;
      let patchLint: PatchLint | undefined;
      try {
        telemetry = JSON.parse(
          await readFile(`${attempt.directory}/telemetry.json`, "utf8"),
        ) as RolloutTelemetry;
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
          patchLint = { paths: [], violations: ["completed artifact is missing patch evidence"] };
        }
      }
      return {
        instanceId: attempt.spec.instanceId,
        config: attempt.spec.config,
        phase: attempt.status.phase,
        ...(attempt.status.failureKind ? { failureKind: attempt.status.failureKind } : {}),
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
    `This is a signal-seeking n=${report.configs["glm-pure"].total} × 1 trial experiment, not a leaderboard estimate.`,
    "",
    "## Paired comparisons",
    "",
  ];
  for (const comparison of report.comparisons) {
    lines.push(
      `### ${comparison.pure} vs ${comparison.advised}`,
      "",
      `- Advisor-only wins: ${comparison.advisorOnlyWins.length}${formatIds(comparison.advisorOnlyWins)}`,
      `- Pure-only wins: ${comparison.pureOnlyWins.length}${formatIds(comparison.pureOnlyWins)}`,
      `- Both resolve: ${comparison.bothResolve.length}`,
      `- Neither resolves: ${comparison.neitherResolves.length}`,
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
    `Total model spend: $${report.totalCostUsd.toFixed(2)}.`,
    `Pure-arm advisor assertion: ${report.pureAdvisorAssertion.passed ? "PASS" : `FAIL (${report.pureAdvisorAssertion.violations.join(", ")})`}.`,
    `Patch assertion: ${report.patchAssertion.passed ? "PASS" : `FAIL (${report.patchAssertion.violations.join(", ")})`}.`,
    "",
  );
  return lines.join("\n");
}

function configFromModel(model: string): CampaignConfigName {
  const value = model.startsWith("duet-") ? model.slice("duet-".length) : model;
  if (
    value !== "glm-pure" &&
    value !== "glm-kimi-advisor" &&
    value !== "kimi-pure" &&
    value !== "kimi-fable-advisor"
  ) {
    throw new Error(`Unknown campaign model_name_or_path: ${model}.`);
  }
  return value;
}

function formatIds(ids: readonly string[]): string {
  return ids.length > 0 ? ` (${ids.join(", ")})` : "";
}

function isAgentComplete(attempt: ReportAttempt | undefined): boolean {
  return (
    attempt?.phase === "completed" &&
    attempt.terminalType === "complete" &&
    attempt.telemetry?.terminalStatus === "completed"
  );
}

/** Check exact staged paths rather than guessing from diff text. */
export function lintPatch(patch: string, paths: readonly string[], maxBytes: number): PatchLint {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) violations.push("patch is empty");
  if (bytes > maxBytes) violations.push(`patch is ${bytes} bytes (limit ${maxBytes})`);
  for (const path of paths) {
    const segments = path.toLowerCase().split("/");
    const filename = segments.at(-1) ?? "";
    if (
      segments.some((segment) => ["test", "tests", "__tests__"].includes(segment)) ||
      /(?:^|[._-])test(?:[._-]|$)/.test(filename)
    ) {
      violations.push(`test file modified: ${path}`);
    }
    if (segments.includes(".duet") || path.startsWith("opt/duet/")) {
      violations.push(`runtime file leaked: ${path}`);
    }
  }
  return { paths: [...paths], violations };
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
