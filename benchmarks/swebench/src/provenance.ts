import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashJson, hashText } from "./artifacts.js";
import type { CampaignConfigName } from "./config-override.js";
import { LocalCommandRunner, type CommandRunner } from "./container.js";
import type { CampaignSpec } from "./orchestrator.js";
import type { DuetArtifact } from "./packaging.js";

/** Frozen campaign inputs embedded beside rollout artifacts. */
export interface CampaignProvenance {
  schemaVersion: 1;
  inputHash: string;
  startedAt: string;
  frozen: {
    spec: CampaignSpec;
    duetGitSha: string;
    duetArtifact: DuetArtifact;
    manifestSha256: string;
    datasetRevision: string;
    renders: Record<CampaignConfigName, { sha256: string; content: unknown }>;
    environment: unknown;
  };
}

/** Write-once provenance; a resume must reproduce the same frozen input hash. */
export async function ensureCampaignProvenance(options: {
  repoRoot: string;
  runsRoot: string;
  spec: CampaignSpec;
  artifact: DuetArtifact;
  manifestPath: string;
  configPaths: Record<CampaignConfigName, string>;
  environmentLockPath: string;
  commands?: CommandRunner;
}): Promise<CampaignProvenance> {
  const commands = options.commands ?? new LocalCommandRunner();
  const [shaResult, statusResult, manifestText, environmentText] = await Promise.all([
    commands.run(["git", "rev-parse", "HEAD"], { cwd: options.repoRoot }),
    commands.run(["git", "status", "--porcelain"], { cwd: options.repoRoot }),
    readFile(options.manifestPath, "utf8"),
    readFile(options.environmentLockPath, "utf8"),
  ]);
  if (shaResult.exitCode !== 0) throw new Error(`Could not read duet git SHA: ${shaResult.stderr}`);
  if (statusResult.exitCode !== 0)
    throw new Error(`Could not inspect duet worktree: ${statusResult.stderr}`);
  if (statusResult.stdout.trim()) {
    throw new Error(
      "Campaign launch requires a clean worktree so the recorded git SHA is complete.",
    );
  }
  const manifest = JSON.parse(manifestText) as { datasetRevision?: unknown };
  if (typeof manifest.datasetRevision !== "string") {
    throw new Error("Campaign manifest is missing datasetRevision.");
  }
  const renders = {} as CampaignProvenance["frozen"]["renders"];
  for (const config of options.spec.configs) {
    const text = await readFile(options.configPaths[config], "utf8");
    renders[config] = { sha256: hashText(text), content: JSON.parse(text) };
  }
  const frozen: CampaignProvenance["frozen"] = {
    spec: options.spec,
    duetGitSha: shaResult.stdout.trim(),
    duetArtifact: options.artifact,
    manifestSha256: hashText(manifestText),
    datasetRevision: manifest.datasetRevision,
    renders,
    environment: JSON.parse(environmentText),
  };
  const inputHash = hashJson(frozen);
  const path = join(options.runsRoot, options.spec.id, "campaign.json");
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as CampaignProvenance;
    if (existing.inputHash !== inputHash) {
      throw new Error(
        `Campaign provenance mismatch for ${options.spec.id}; use a new campaign id.`,
      );
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record: CampaignProvenance = {
    schemaVersion: 1,
    inputHash,
    startedAt: new Date().toISOString(),
    frozen,
  };
  await mkdir(join(options.runsRoot, options.spec.id), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return record;
}
