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
} from "./container.js";
import type { DatasetRow, InstanceManifest, ManifestEntry } from "./manifest.js";
import { buildRolloutPrompt } from "./prompt.js";
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
  /** Explicit arms; campaign 1 supplies all four committed renders. */
  configs: CampaignConfigName[];
  /** Independent attempts per logical arm; campaign 1 fixes this to one. */
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
    /** Shared experiment envelope enforced before each rollout launch. */
    totalUsd: number;
    /** Spend from prerequisite smokes or earlier campaign ids. */
    sunkUsd: number;
  };
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

/** Execute pending instance blocks with exact-image cleanup and a reserve-first breaker. */
export async function runCampaign(
  spec: CampaignSpec,
  runtime: CampaignRuntime,
  options: { retryFailed: boolean; onResult?: (result: RunRolloutResult) => void } = {
    retryFailed: false,
  },
): Promise<RunRolloutResult[]> {
  const attempts = await loadRolloutAttempts(runtime.runsRoot, spec.id);
  const plan = planCampaign(spec, runtime, attempts, options.retryFailed);
  const blocks = groupByInstance(plan);
  const results: RunRolloutResult[] = [];
  let accountedUsd = spec.budget.sunkUsd + accountedAttemptSpend(attempts);
  let nextBlock = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const blockIndex = nextBlock++;
      const block = blocks[blockIndex];
      if (!block) return;
      const official = await resolveAndPullOfficialImage(block[0]!.entry.instanceId, {
        pythonPath: runtime.pythonPath,
        helperPath: runtime.imageHelperPath,
        ...(runtime.commands ? { commands: runtime.commands } : {}),
      });
      try {
        for (const item of block) {
          const reserved = spec.limits.costUsd;
          if (accountedUsd + reserved > spec.budget.totalUsd) {
            throw new Error(
              `Campaign budget breaker: $${accountedUsd.toFixed(4)} accounted + $${reserved.toFixed(4)} reserve exceeds $${spec.budget.totalUsd.toFixed(2)}.`,
            );
          }
          accountedUsd += reserved;
          const result = await runRollout(
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
              configPath: runtime.configPaths[item.config],
              configSha256: runtime.configHashes[item.config],
              limits: spec.limits,
            },
          );
          accountedUsd -= reserved;
          accountedUsd +=
            result.status.costUsd ??
            (result.status.failureKind === "infra" ? spec.limits.costUsd : 0);
          results.push(result);
          options.onResult?.(result);
          if (result.status.failureKind === "infra") {
            throw new Error(
              `Infrastructure failure in ${item.entry.instanceId}/${item.config}: ${result.status.message}`,
            );
          }
        }
      } finally {
        await removeOfficialImage(official.image, runtime.commands);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(spec.concurrency, blocks.length) }, worker));
  return results;
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
      duetSha256: runtime.artifact.sha256,
      configSha256: runtime.configHashes[config],
      promptSha256: hashText(
        buildRolloutPrompt({ entry, problemStatement: datasetRow.problemStatement }),
      ),
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
}
