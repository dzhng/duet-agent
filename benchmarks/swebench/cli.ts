#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

import {
  CAMPAIGN_CONFIGS,
  renderCampaignConfigs,
  serializeModelsJson,
  type CampaignConfigName,
} from "./src/config-override.js";
import { runDuetTurn, spawnLocalDuetRpc } from "./src/duet-client.js";
import { PINNED_DATASET_REVISION, fetchDataset, writeDatasetCache } from "./src/fetch-dataset.js";
import {
  LANGUAGES,
  selectManifest,
  serializeManifest,
  type InstanceManifest,
} from "./src/manifest.js";
import { loadRolloutAttempts } from "./src/artifacts.js";
import { runCampaign, type CampaignRuntime, type CampaignSpec } from "./src/orchestrator.js";
import { prepareDuetArtifact } from "./src/packaging.js";
import { buildPredictions, serializePredictions } from "./src/predictions.js";
import { ensureCampaignProvenance } from "./src/provenance.js";
import {
  buildCampaignReport,
  loadReportAttempts,
  renderCampaignReport,
  type OfficialScoreRow,
} from "./src/report.js";
import { hashConfigFile } from "./src/rollout.js";
import { deriveTelemetry } from "./src/telemetry.js";

const ROOT = import.meta.dir;
const REPO_ROOT = resolve(ROOT, "..", "..");
const MANIFEST_PATH = join(ROOT, "manifests", "multilingual-30.json");
const CACHE_PATH = join(ROOT, ".cache", "multilingual-test.json");
const CONFIG_DIR = join(ROOT, "configs");
const MANIFEST_SEED = 20_260_720;

async function writeManifest(): Promise<void> {
  const snapshot = await fetchDataset({ expectedRevision: PINNED_DATASET_REVISION });
  const manifest = selectManifest(snapshot, { seed: MANIFEST_SEED, size: 30 });
  await writeDatasetCache(CACHE_PATH, snapshot);
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, serializeManifest(manifest));
  console.log(`Wrote ${manifest.entries.length} instances to ${MANIFEST_PATH}`);
}

async function showManifest(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as InstanceManifest;
  console.log(`revision  ${manifest.datasetRevision}`);
  console.log(`seed      ${manifest.seed}`);
  console.log(`algorithm ${manifest.algorithmVersion}`);
  console.log("language    count  instances");
  for (const language of LANGUAGES) {
    const entries = manifest.entries.filter((entry) => entry.language === language);
    console.log(
      `${language.padEnd(11)} ${String(entries.length).padStart(5)}  ${entries.map((entry) => entry.instanceId).join(", ")}`,
    );
  }
}

async function writeConfigs(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  for (const [name, table] of Object.entries(renderCampaignConfigs())) {
    await writeFile(join(CONFIG_DIR, `${name}.models.json`), serializeModelsJson(table));
  }
  console.log(`Wrote ${Object.keys(CAMPAIGN_CONFIGS).length} routing tables to ${CONFIG_DIR}`);
}

async function showConfigs(): Promise<void> {
  for (const name of Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[]) {
    const path = join(CONFIG_DIR, `${name}.models.json`);
    console.log(`\n# ${name}: ${path}`);
    process.stdout.write(await readFile(path, "utf8"));
  }
  console.log("\nglm comparison: tiers.swebench.advisor.enabled false -> true");
  console.log("kimi comparison: tiers.swebench.advisor.enabled false -> true");
}

async function runLocalRollout(args: string[]): Promise<void> {
  const promptIndex = args.indexOf("--prompt");
  const prompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
  if (!prompt) throw new Error("rollout local requires --prompt");

  const transport = spawnLocalDuetRpc([
    "--incognito",
    "--model",
    "economy",
    "--no-system-prompt-files",
  ]);
  const outcome = await runDuetTurn(
    transport,
    { limits: { costUsd: 1, wallClockMs: 120_000 } },
    prompt,
  );
  const transcriptTail = outcome.events
    .filter((event) => event.type === "step" && event.step.type === "text")
    .slice(-3)
    .map((event) => (event.type === "step" && event.step.type === "text" ? event.step.text : ""));

  console.log(
    JSON.stringify(
      { terminal: outcome.terminal, transcriptTail, telemetry: deriveTelemetry(outcome.events) },
      null,
      2,
    ),
  );
}

async function readCampaignSpec(args: string[]): Promise<CampaignSpec> {
  const specFlag = args.indexOf("--spec");
  const path = specFlag >= 0 ? args[specFlag + 1] : undefined;
  if (!path) throw new Error("campaign command requires --spec PATH");
  return JSON.parse(await readFile(resolve(REPO_ROOT, path), "utf8")) as CampaignSpec;
}

async function buildCampaignRuntime(spec: CampaignSpec): Promise<CampaignRuntime> {
  const manifestPath = isAbsolute(spec.manifestPath)
    ? spec.manifestPath
    : resolve(REPO_ROOT, spec.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InstanceManifest;
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(CACHE_PATH, "utf8")) as Awaited<
      ReturnType<typeof fetchDataset>
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    snapshot = await fetchDataset({ expectedRevision: manifest.datasetRevision });
    await writeDatasetCache(CACHE_PATH, snapshot);
  }
  if (snapshot.datasetRevision !== manifest.datasetRevision) {
    throw new Error(
      `Dataset cache revision ${snapshot.datasetRevision} does not match manifest ${manifest.datasetRevision}.`,
    );
  }

  const artifact = await prepareDuetArtifact({
    repoRoot: REPO_ROOT,
    outputDir: join(ROOT, "runtime", "build"),
  });
  const names = Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[];
  const configPaths = Object.fromEntries(
    names.map((name) => [name, join(CONFIG_DIR, `${name}.models.json`)]),
  ) as Record<CampaignConfigName, string>;
  const configHashes = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await hashConfigFile(configPaths[name])])),
  ) as Record<CampaignConfigName, string>;

  return {
    repoRoot: REPO_ROOT,
    runsRoot: join(ROOT, "runs"),
    artifact,
    manifest,
    datasetRows: snapshot.rows,
    configPaths,
    configHashes,
    providerEnv: await loadProviderEnv(),
    pythonPath: join(ROOT, ".venv", "bin", "python"),
    imageHelperPath: join(ROOT, "mac", "official_image.py"),
  };
}

async function runCommittedCampaign(args: string[]): Promise<void> {
  const spec = await readCampaignSpec(args);
  const runtime = await buildCampaignRuntime(spec);
  await ensureCampaignProvenance({
    repoRoot: REPO_ROOT,
    runsRoot: runtime.runsRoot,
    spec,
    artifact: runtime.artifact,
    manifestPath: resolve(REPO_ROOT, spec.manifestPath),
    configPaths: runtime.configPaths,
    environmentLockPath: join(ROOT, "mac", "environment.lock.json"),
  });
  const retryFailed = args.includes("--retry-failed");
  const results = await runCampaign(spec, runtime, {
    retryFailed,
    onResult: ({ attempt, status }) => {
      console.log(
        `${status.phase.padEnd(9)} ${attempt.spec.instanceId} ${attempt.spec.config} $${(status.costUsd ?? 0).toFixed(4)} ${status.terminalType ?? status.failureKind ?? ""}`,
      );
    },
  });
  console.log(`Campaign ${spec.id}: ${results.length} rollout(s) executed.`);
}

async function showCampaignStatus(args: string[]): Promise<void> {
  const spec = await readCampaignSpec(args);
  const attempts = await loadRolloutAttempts(join(ROOT, "runs"), spec.id);
  let cost = 0;
  for (const attempt of attempts.sort((a, b) => a.directory.localeCompare(b.directory))) {
    cost += attempt.status.costUsd ?? 0;
    console.log(
      `${attempt.status.phase.padEnd(9)} ${attempt.spec.instanceId} ${attempt.spec.config} a${attempt.status.attempt} $${(attempt.status.costUsd ?? 0).toFixed(4)}`,
    );
  }
  console.log(`${attempts.length} attempt(s); recorded model spend $${cost.toFixed(4)}.`);
}

async function writeCampaignPredictions(args: string[]): Promise<void> {
  const spec = await readCampaignSpec(args);
  const attempts = await loadRolloutAttempts(join(ROOT, "runs"), spec.id);
  const outputRoot = join(ROOT, ".cache", spec.id, "predictions");
  await mkdir(outputRoot, { recursive: true });
  for (const config of spec.configs) {
    const predictions = await buildPredictions(attempts, config);
    const path = join(outputRoot, `${config}.jsonl`);
    await writeFile(path, serializePredictions(predictions));
    console.log(`${config}: ${predictions.length} prediction(s) -> ${path}`);
  }
}

async function writeCampaignReport(args: string[]): Promise<void> {
  const spec = await readCampaignSpec(args);
  const scoreFlag = args.indexOf("--scores");
  const scorePath =
    scoreFlag >= 0 && args[scoreFlag + 1]
      ? resolve(REPO_ROOT, args[scoreFlag + 1]!)
      : join(ROOT, ".cache", spec.id, "scores", "summary.json");
  const [manifest, attempts, scoreSummary] = await Promise.all([
    readFile(resolve(REPO_ROOT, spec.manifestPath), "utf8").then(
      (value) => JSON.parse(value) as InstanceManifest,
    ),
    loadRolloutAttempts(join(ROOT, "runs"), spec.id),
    readFile(scorePath, "utf8").then(
      (value) => JSON.parse(value) as { results: OfficialScoreRow[] },
    ),
  ]);
  const selected = new Set(spec.instanceIds ?? manifest.entries.map((entry) => entry.instanceId));
  const report = buildCampaignReport(
    manifest.entries.filter((entry) => selected.has(entry.instanceId)),
    await loadReportAttempts(attempts),
    scoreSummary.results,
  );
  const outputRoot = join(ROOT, ".cache", spec.id, "report");
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(join(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(outputRoot, "report.md"), renderCampaignReport(report)),
  ]);
  console.log(renderCampaignReport(report));
  if (!report.pureAdvisorAssertion.passed || !report.patchAssertion.passed) process.exitCode = 1;
}

async function loadProviderEnv(): Promise<Record<string, string>> {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseDotenv(await readFile(join(REPO_ROOT, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result: Record<string, string> = {};
  for (const name of ["DUET_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"] as const) {
    const value = process.env[name] ?? fileValues[name];
    if (value) result[name] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("No supported gateway key found in process env or the repository .env file.");
  }
  return result;
}

const [domain, action, ...rest] = process.argv.slice(2);
if (domain === "manifest" && action === "update") await writeManifest();
else if (domain === "manifest" && action === "show") await showManifest();
else if (domain === "config" && action === "write") await writeConfigs();
else if (domain === "config" && action === "show") await showConfigs();
else if (domain === "rollout" && action === "local") await runLocalRollout(rest);
else if (domain === "campaign" && action === "run") await runCommittedCampaign(rest);
else if (domain === "campaign" && action === "status") await showCampaignStatus(rest);
else if (domain === "campaign" && action === "predictions") await writeCampaignPredictions(rest);
else if (domain === "campaign" && action === "report") await writeCampaignReport(rest);
else {
  console.error(
    "Usage: bun benchmarks/swebench/cli.ts <manifest update|manifest show|config write|config show|rollout local --prompt TEXT|campaign run|status|predictions|report --spec PATH>",
  );
  process.exitCode = 1;
}
