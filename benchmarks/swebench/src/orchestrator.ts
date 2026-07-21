import type { DuetArtifact } from "./packaging.js";
import {
  hashJson,
  hashText,
  loadRolloutAttempts,
  type RolloutArtifactSpec,
  type RolloutAttempt,
} from "./artifacts.js";
import type { CampaignConfigName } from "./config-override.js";
import {
  ContainerHandle,
  removeOfficialImage,
  resolveAndPullOfficialImage,
  type CommandRunner,
  type OfficialImage,
} from "./container.js";
import {
  selectPilotInstanceIds,
  type DatasetRow,
  type InstanceManifest,
  type ManifestEntry,
} from "./manifest.js";
import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "./prompt.js";
import { runRollout, type RolloutContainer, type RunRolloutResult } from "./rollout.js";

/** Committed, self-contained execution policy for a resumable campaign. */
export interface CampaignSpec {
  schemaVersion: 1;
  /** Filesystem namespace; changing frozen inputs requires a new id. */
  id: string;
  /** Manifest path recorded in campaign provenance. */
  manifestPath: string;
  /** Optional fixed subset used by pilot campaigns. */
  instanceIds?: string[];
  /** Seed proving an instance subset came from the committed pilot selector. */
  instanceSelectionSeed?: number;
  /** Explicit model-treatment arms included in this campaign. */
  configs: CampaignConfigName[];
  /** Independent attempts per logical arm. */
  trials: number;
  /** Maximum simultaneous instance blocks. This Mac is admitted only at one. */
  concurrency: number;
  /** Seed controlling within-instance arm order to spread provider drift. */
  armOrderSeed: number;
  limits: {
    costUsd: number;
    wallClockMs: number;
    interruptGraceMs: number;
    patchBytes: number;
  };
  budget: {
    /** Local-process admission envelope checked before each pending instance block. */
    totalUsd: number;
    /** Spend from prerequisite smokes or earlier campaign ids. */
    sunkUsd: number;
  };
  /** Where instance blocks execute; omitted historical specs use the local Docker host. */
  execution?:
    | { backend: "local" }
    | {
        backend: "e2b";
        /** Maximum E2B sandboxes running independent instance-trial shards at once. */
        workerConcurrency: number;
        /** vCPUs frozen into the campaign's E2B template. */
        workerCpuCount: number;
        /** Memory in MiB frozen into the campaign's E2B template. */
        workerMemoryMb: number;
        /** Lifetime allowed for one sandbox to finish every campaign arm in one trial. */
        workerTimeoutMs: number;
      };
}

/** Reserve every pending arm before an instance block can begin paid work. */
export function reserveInstanceBlock(
  accountedUsd: number,
  pendingRollouts: number,
  rolloutReserveUsd: number,
  totalBudgetUsd: number,
): number {
  const reservedUsd = pendingRollouts * rolloutReserveUsd;
  if (accountedUsd + reservedUsd > totalBudgetUsd) {
    throw new Error(
      `Campaign budget breaker: ${pendingRollouts} pending rollouts require a $${reservedUsd.toFixed(4)} reserve, but $${accountedUsd.toFixed(4)} is already accounted against the $${totalBudgetUsd.toFixed(2)} budget.`,
    );
  }
  return accountedUsd + reservedUsd;
}

/** Host paths and secrets intentionally absent from committed campaign specs. */
export interface CampaignRuntime {
  repoRoot: string;
  runsRoot: string;
  artifact: DuetArtifact;
  manifest: InstanceManifest;
  datasetRows: DatasetRow[];
  configPaths: Record<CampaignConfigName, string>;
  configHashes: Record<CampaignConfigName, string>;
  providerEnv: Record<string, string>;
  pythonPath: string;
  imageHelperPath: string;
  commands?: CommandRunner;
  containerFactory?: (name: string, image: string) => RolloutContainer;
  /** Injectable official-image boundary used by deterministic orchestrator tests. */
  resolveOfficialImage?: (instanceId: string) => Promise<OfficialImage>;
  /** Injectable cleanup paired with {@link resolveOfficialImage}. */
  removeOfficialImage?: (imageId: string) => Promise<void>;
  /** Injectable paid-rollout boundary; production uses {@link runRollout}. */
  rolloutRunner?: typeof runRollout;
}

/** One pending logical rollout in deterministic execution order. */
export interface PlannedRollout {
  entry: ManifestEntry;
  datasetRow: DatasetRow;
  config: CampaignConfigName;
  trial: number;
}

/** Pure resume plan after matching existing artifacts against current inputs. */
export function planCampaign(
  spec: CampaignSpec,
  runtime: CampaignRuntime,
  attempts: readonly RolloutAttempt[],
  retryFailed: boolean,
): PlannedRollout[] {
  validateCampaign(spec, runtime.manifest);
  const rowsById = new Map(runtime.datasetRows.map((row) => [row.instanceId, row]));
  const selected = new Set(
    spec.instanceIds ?? runtime.manifest.entries.map((entry) => entry.instanceId),
  );
  const pending: PlannedRollout[] = [];

  for (const entry of runtime.manifest.entries) {
    if (!selected.has(entry.instanceId)) continue;
    const datasetRow = rowsById.get(entry.instanceId);
    if (!datasetRow) throw new Error(`Pinned dataset row missing for ${entry.instanceId}.`);
    for (let trial = 1; trial <= spec.trials; trial += 1) {
      for (const config of seededArmOrder(
        spec.configs,
        spec.armOrderSeed,
        entry.instanceId,
        trial,
      )) {
        const existing = attempts.filter(
          (attempt) =>
            attempt.spec.instanceId === entry.instanceId &&
            attempt.spec.config === config &&
            attempt.spec.trial === trial,
        );
        assertAttemptsMatchCurrentInputs(spec, runtime, entry, datasetRow, config, trial, existing);
        if (existing.some((attempt) => attempt.status.phase === "completed")) continue;
        const latest = [...existing].sort((a, b) => b.status.attempt - a.status.attempt)[0];
        if (
          latest?.status.phase === "failed" &&
          (latest.status.failureKind !== "infra" || !retryFailed)
        ) {
          continue;
        }
        pending.push({ entry, datasetRow, config, trial });
      }
    }
  }
  return pending;
}

/** Execute pending blocks with exact-image cleanup and process-local reserve-first admission. */
export async function runCampaign(
  spec: CampaignSpec,
  runtime: CampaignRuntime,
  options: {
    retryFailed: boolean;
    /** Runtime-only shard selection; provenance always retains the full committed spec. */
    instanceIds?: readonly string[];
    /** Runtime-only trial selection used to parallelize independent E2B pairs. */
    trials?: readonly number[];
    onResult?: (result: RunRolloutResult) => void;
  } = {
    retryFailed: false,
  },
): Promise<RunRolloutResult[]> {
  const attempts = await loadRolloutAttempts(runtime.runsRoot, spec.id);
  const fullPlan = planCampaign(spec, runtime, attempts, options.retryFailed);
  const plan = filterPlanForExecution(
    fullPlan,
    options.instanceIds,
    runtime.manifest,
    options.trials,
  );
  const blocks = groupByInstance(plan);
  const results: RunRolloutResult[] = [];
  let accountedUsd = spec.budget.sunkUsd + accountedAttemptSpend(attempts);
  let nextBlock = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const blockIndex = nextBlock++;
      const block = blocks[blockIndex];
      if (!block) return;
      const rolloutReserveUsd = spec.limits.costUsd;
      accountedUsd = reserveInstanceBlock(
        accountedUsd,
        block.length,
        rolloutReserveUsd,
        spec.budget.totalUsd,
      );
      let unstartedReservations = block.length;
      let official: Awaited<ReturnType<typeof resolveAndPullOfficialImage>> | undefined;
      try {
        official = runtime.resolveOfficialImage
          ? await runtime.resolveOfficialImage(block[0]!.entry.instanceId)
          : await resolveAndPullOfficialImage(block[0]!.entry.instanceId, {
              pythonPath: runtime.pythonPath,
              helperPath: runtime.imageHelperPath,
              ...(runtime.commands ? { commands: runtime.commands } : {}),
            });
        assertResolvedImageMatchesAttempts(block[0]!.entry.instanceId, attempts, official);
        for (const item of block) {
          unstartedReservations -= 1;
          const result = await (runtime.rolloutRunner ?? runRollout)(
            {
              runsRoot: runtime.runsRoot,
              artifact: runtime.artifact,
              providerEnv: runtime.providerEnv,
              containerFactory:
                runtime.containerFactory ??
                ((name, image) => new ContainerHandle(name, image, runtime.commands)),
            },
            {
              campaignId: spec.id,
              config: item.config,
              entry: item.entry,
              datasetRow: item.datasetRow,
              trial: item.trial,
              image: official.image,
              imageId: official.imageId,
              configPath: runtime.configPaths[item.config],
              configSha256: runtime.configHashes[item.config],
              limits: spec.limits,
            },
          );
          accountedUsd -= rolloutReserveUsd;
          accountedUsd +=
            result.status.costUsd ??
            (result.status.failureKind === "infra" ? spec.limits.costUsd : 0);
          results.push(result);
          options.onResult?.(result);
          if (accountedUsd > spec.budget.totalUsd) {
            throw new Error(
              `Campaign budget exceeded after provider-reported spend: $${accountedUsd.toFixed(4)} accounted including active reservations against $${spec.budget.totalUsd.toFixed(2)}.`,
            );
          }
          if (result.status.failureKind === "infra") {
            throw new Error(
              `Infrastructure failure in ${item.entry.instanceId}/${item.config}: ${result.status.message}`,
            );
          }
        }
      } finally {
        accountedUsd -= unstartedReservations * rolloutReserveUsd;
        if (official) {
          if (runtime.removeOfficialImage) await runtime.removeOfficialImage(official.imageId);
          else await removeOfficialImage(official.imageId, runtime.commands);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(spec.concurrency, blocks.length) }, worker));
  return results;
}

/** Select a runtime-only subset without changing the campaign's frozen inputs. */
export function filterPlanForExecution(
  plan: readonly PlannedRollout[],
  instanceIds: readonly string[] | undefined,
  manifest: InstanceManifest,
  trials?: readonly number[],
): PlannedRollout[] {
  const requested = instanceIds ? new Set(instanceIds) : undefined;
  const requestedTrials = trials ? new Set(trials) : undefined;
  const known = new Set(manifest.entries.map((entry) => entry.instanceId));
  for (const instanceId of requested ?? []) {
    if (!known.has(instanceId)) {
      throw new Error(`Execution selection is not in the manifest: ${instanceId}.`);
    }
  }
  return plan.filter(
    (item) =>
      (!requested || requested.has(item.entry.instanceId)) &&
      (!requestedTrials || requestedTrials.has(item.trial)),
  );
}

function assertAttemptsMatchCurrentInputs(
  campaign: CampaignSpec,
  runtime: CampaignRuntime,
  entry: ManifestEntry,
  datasetRow: DatasetRow,
  config: CampaignConfigName,
  trial: number,
  attempts: readonly RolloutAttempt[],
): void {
  for (const attempt of attempts) {
    const expected: RolloutArtifactSpec = {
      campaignId: campaign.id,
      config,
      instanceId: entry.instanceId,
      trial,
      image: attempt.spec.image,
      imageId: attempt.spec.imageId,
      duetSha256: runtime.artifact.sha256,
      configSha256: runtime.configHashes[config],
      systemPromptSha256: hashText(SWEBENCH_SYSTEM_PROMPT),
      promptSha256: hashText(buildRolloutPrompt({ problemStatement: datasetRow.problemStatement })),
      limits: {
        costUsd: campaign.limits.costUsd,
        wallClockMs: campaign.limits.wallClockMs,
        interruptGraceMs: campaign.limits.interruptGraceMs,
        patchBytes: campaign.limits.patchBytes,
      },
    };
    if (
      datasetRow.instanceId !== entry.instanceId ||
      hashJson(expected) !== attempt.status.specHash
    ) {
      throw new Error(
        `specHash mismatch for ${entry.instanceId}/${config}/t${trial}; use a new campaign id.`,
      );
    }
  }
}

function assertResolvedImageMatchesAttempts(
  instanceId: string,
  attempts: readonly RolloutAttempt[],
  official: Pick<OfficialImage, "image" | "imageId">,
): void {
  for (const attempt of attempts) {
    if (attempt.spec.instanceId !== instanceId) continue;
    if (attempt.spec.image !== official.image || attempt.spec.imageId !== official.imageId) {
      throw new Error(
        `Official image changed for ${instanceId}; use a new campaign id instead of mixing task-image content.`,
      );
    }
  }
}

function groupByInstance(plan: readonly PlannedRollout[]): PlannedRollout[][] {
  const blocks = new Map<string, PlannedRollout[]>();
  for (const item of plan) {
    const existing = blocks.get(item.entry.instanceId);
    if (existing) existing.push(item);
    else blocks.set(item.entry.instanceId, [item]);
  }
  return [...blocks.values()];
}

function accountedAttemptSpend(attempts: readonly RolloutAttempt[]): number {
  return attempts.reduce((total, attempt) => {
    if (attempt.status.costUsd !== undefined) return total + attempt.status.costUsd;
    if (attempt.status.phase === "running") return total + attempt.spec.limits.costUsd;
    if (attempt.status.failureKind === "infra") return total + attempt.spec.limits.costUsd;
    return total;
  }, 0);
}

function seededArmOrder(
  configs: readonly CampaignConfigName[],
  seed: number,
  instanceId: string,
  trial: number,
): CampaignConfigName[] {
  const values = [...configs];
  let state = hashSeed(`${seed}:${instanceId}:${trial}`);
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
  return values;
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function validateCampaign(spec: CampaignSpec, manifest: InstanceManifest): void {
  if (spec.schemaVersion !== 1) throw new Error("Unsupported campaign schemaVersion.");
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.id)) throw new Error("Campaign id is not path-safe.");
  if (!Number.isSafeInteger(spec.trials) || spec.trials < 1) {
    throw new Error("Campaign trials must be a positive integer.");
  }
  if (!Number.isSafeInteger(spec.concurrency) || spec.concurrency < 1) {
    throw new Error("Campaign concurrency must be a positive integer.");
  }
  if (spec.configs.length === 0 || new Set(spec.configs).size !== spec.configs.length) {
    throw new Error("Campaign configs must be a non-empty unique list.");
  }
  const manifestIds = new Set(manifest.entries.map((entry) => entry.instanceId));
  for (const instanceId of spec.instanceIds ?? []) {
    if (!manifestIds.has(instanceId))
      throw new Error(`Campaign instance not in manifest: ${instanceId}.`);
  }
  if (spec.instanceSelectionSeed !== undefined) {
    if (!spec.instanceIds?.length) {
      throw new Error("Campaign instanceSelectionSeed requires a non-empty instanceIds subset.");
    }
    const expected = selectPilotInstanceIds(manifest, {
      seed: spec.instanceSelectionSeed,
      size: spec.instanceIds.length,
    });
    if (JSON.stringify([...spec.instanceIds].sort()) !== JSON.stringify(expected)) {
      throw new Error("Campaign instanceIds do not match the recorded pilot selection seed.");
    }
  }
  for (const value of [
    spec.limits.costUsd,
    spec.limits.wallClockMs,
    spec.limits.interruptGraceMs,
    spec.limits.patchBytes,
    spec.budget.totalUsd,
    spec.budget.sunkUsd,
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Campaign limits must be finite.");
  }
  if (spec.execution?.backend === "e2b") {
    for (const [name, value] of Object.entries({
      workerConcurrency: spec.execution.workerConcurrency,
      workerCpuCount: spec.execution.workerCpuCount,
      workerMemoryMb: spec.execution.workerMemoryMb,
      workerTimeoutMs: spec.execution.workerTimeoutMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Campaign E2B ${name} must be a positive integer.`);
      }
    }
  }
}
