import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { DEEPSWE_ARM_NAMES, type DeepSweArmName } from "./config.js";

export interface DeepSweResultRow {
  arm: DeepSweArmName;
  taskId: string;
  resolved: boolean;
  costUsd: number | null;
  exception?: string;
}

export interface DeepSweArmReport {
  arm: DeepSweArmName;
  completed: number;
  resolved: number;
  resolveRate: number;
  totalCostUsd: number;
  costPerTaskUsd: number;
  costPerResolvedUsd: number | null;
}

export interface DeepSwePairReport {
  pair: "glm" | "kimi";
  completedTasks: number;
  bothResolved: number;
  advisorOnly: number;
  pureOnlyRegression: number;
  neitherResolved: number;
  /** Tasks that cannot enter the paired denominator until both arms finish. */
  missingArms: Array<{ taskId: string; missing: DeepSweArmName[] }>;
}

export interface DeepSweMissingArms {
  taskId: string;
  missing: DeepSweArmName[];
}

/** Enumerate every absent configured arm before publishing campaign headlines. */
export function findMissingDeepSweArms(
  rows: readonly DeepSweResultRow[],
  expectedTaskIds: readonly string[],
): DeepSweMissingArms[] {
  return [...new Set(expectedTaskIds)].flatMap((taskId) => {
    const completedArms = new Set(
      rows.filter((row) => row.taskId === taskId).map((row) => row.arm),
    );
    const missing = DEEPSWE_ARM_NAMES.filter((arm) => !completedArms.has(arm));
    return missing.length === 0 ? [] : [{ taskId, missing }];
  });
}

/** A task is complete only after every configured arm has one durable outcome. */
export function hasEveryDeepSweArm(rows: readonly DeepSweResultRow[], taskId: string): boolean {
  return findMissingDeepSweArms(rows, [taskId]).length === 0;
}

/** Use the campaign's frozen subset instead of inventing missing rows for the full manifest. */
export async function loadDeepSweCampaignTaskIds(
  campaignRoot: string,
  manifestTaskIds: readonly string[],
): Promise<string[]> {
  const path = join(campaignRoot, "campaign.json");
  const campaign = await readFile(path, "utf8")
    .then((value) => JSON.parse(value) as { taskIds?: unknown })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (!campaign) return [...manifestTaskIds];
  if (
    !Array.isArray(campaign.taskIds) ||
    campaign.taskIds.length === 0 ||
    !campaign.taskIds.every((taskId): taskId is string => typeof taskId === "string")
  ) {
    throw new Error(`Invalid DeepSWE campaign taskIds in ${path}.`);
  }
  const taskIds = [...new Set(campaign.taskIds)];
  if (taskIds.length !== campaign.taskIds.length) {
    throw new Error(`Duplicate DeepSWE campaign taskId in ${path}.`);
  }
  const manifestSet = new Set(manifestTaskIds);
  for (const taskId of taskIds) {
    if (!manifestSet.has(taskId)) {
      throw new Error(`DeepSWE campaign task is not in the frozen manifest: ${taskId}.`);
    }
  }
  return taskIds;
}

/** Load Pier's official trial records without reproducing its scoring logic. */
export async function loadDeepSweResults(jobsRoot: string): Promise<DeepSweResultRow[]> {
  const resultPaths = (await walk(jobsRoot)).filter((path) => path.endsWith("/result.json"));
  const rows = await Promise.all(
    resultPaths.map(async (path): Promise<DeepSweResultRow | undefined> => {
      const result = JSON.parse(await readFile(path, "utf8")) as PierTrialResult;
      if (!result.task_name || !result.agent_info?.model_info?.name) return undefined;
      const arm = result.agent_info.model_info?.name;
      if (!isArmName(arm)) throw new Error(`Unknown DeepSWE arm in ${path}: ${arm ?? "missing"}`);
      const exception = result.exception_info?.exception_type;
      if (isRetryableInfrastructureException(exception)) return undefined;
      return {
        arm,
        taskId: result.task_name.replace(/^datacurve\//, ""),
        resolved: result.verifier_result?.rewards?.reward === 1,
        costUsd: result.agent_result?.cost_usd ?? null,
        ...(exception ? { exception } : {}),
      };
    }),
  );
  return rows.filter((row): row is DeepSweResultRow => row !== undefined);
}

const NON_RETRYABLE_OUTCOME_EXCEPTIONS = new Set([
  "AgentTimeoutError",
  "VerifierTimeoutError",
  "RewardFileNotFoundError",
  "RewardFileEmptyError",
  "VerifierOutputParseError",
]);

/**
 * Match Pier 0.3.0's retry policy: model/verifier outcomes stay final while
 * environment, setup, adapter, and process failures remain resumable.
 */
export function isRetryableInfrastructureException(exception: string | undefined): boolean {
  return exception !== undefined && !NON_RETRYABLE_OUTCOME_EXCEPTIONS.has(exception);
}

/** Aggregate resolve rate and cost efficiency from official Pier trial rows. */
export function buildDeepSweReport(rows: readonly DeepSweResultRow[]): DeepSweArmReport[] {
  assertCompleteCostAccounting(rows);
  const arms = DEEPSWE_ARM_NAMES.filter((arm) => rows.some((row) => row.arm === arm));
  return arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    const resolved = armRows.filter((row) => row.resolved).length;
    const totalCostUsd = armRows.reduce((total, row) => total + row.costUsd!, 0);
    return {
      arm,
      completed: armRows.length,
      resolved,
      resolveRate: armRows.length === 0 ? 0 : resolved / armRows.length,
      totalCostUsd,
      costPerTaskUsd: armRows.length === 0 ? 0 : totalCostUsd / armRows.length,
      costPerResolvedUsd: resolved === 0 ? null : totalCostUsd / resolved,
    };
  });
}

/** Cost headlines are invalid if any completed Pier row lacks Duet accounting. */
export function assertCompleteCostAccounting(rows: readonly DeepSweResultRow[]): void {
  const missing = rows.filter((row) => row.costUsd === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing DeepSWE cost accounting:\n${missing
        .map((row) => `- ${row.taskId}/${row.arm}`)
        .join("\n")}`,
    );
  }
}

/** Build paired outcome categories without admitting incomplete task pairs. */
export function buildDeepSwePairedReport(
  rows: readonly DeepSweResultRow[],
  expectedTaskIds: readonly string[] = [...new Set(rows.map((row) => row.taskId))],
): DeepSwePairReport[] {
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = `${row.taskId}\0${row.arm}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate DeepSWE result for ${row.taskId}/${row.arm}.`);
    }
    identities.add(identity);
  }
  return [
    paired(rows, expectedTaskIds, "glm", "glm-pure", "glm-kimi-advisor"),
    paired(rows, expectedTaskIds, "kimi", "kimi-pure", "kimi-fable-advisor"),
  ];
}

interface PierTrialResult {
  task_name?: string;
  agent_info?: { model_info?: { name?: string } };
  agent_result?: { cost_usd?: number | null };
  verifier_result?: { rewards?: { reward?: number } };
  exception_info?: { exception_type?: string };
}

function paired(
  rows: readonly DeepSweResultRow[],
  expectedTaskIds: readonly string[],
  pair: DeepSwePairReport["pair"],
  pureArm: DeepSweArmName,
  advisedArm: DeepSweArmName,
): DeepSwePairReport {
  const relevant = rows.filter((row) => row.arm === pureArm || row.arm === advisedArm);
  const taskIds = [...new Set(expectedTaskIds)].sort();
  const report: DeepSwePairReport = {
    pair,
    completedTasks: 0,
    bothResolved: 0,
    advisorOnly: 0,
    pureOnlyRegression: 0,
    neitherResolved: 0,
    missingArms: [],
  };
  for (const taskId of taskIds) {
    const pure = relevant.find((row) => row.taskId === taskId && row.arm === pureArm);
    const advised = relevant.find((row) => row.taskId === taskId && row.arm === advisedArm);
    const missing = [
      ...(!pure ? [pureArm] : []),
      ...(!advised ? [advisedArm] : []),
    ] as DeepSweArmName[];
    if (missing.length > 0) {
      report.missingArms.push({ taskId, missing });
      continue;
    }
    report.completedTasks += 1;
    if (pure.resolved && advised.resolved) report.bothResolved += 1;
    else if (!pure.resolved && advised.resolved) report.advisorOnly += 1;
    else if (pure.resolved && !advised.resolved) report.pureOnlyRegression += 1;
    else report.neitherResolved += 1;
  }
  return report;
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
    )
  ).flat();
}

function isArmName(value: string | undefined): value is DeepSweArmName {
  return value !== undefined && DEEPSWE_ARM_NAMES.some((arm) => arm === value);
}
