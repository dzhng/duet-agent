#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
import { deriveTelemetry } from "./src/telemetry.js";

const ROOT = import.meta.dir;
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

const [domain, action, ...rest] = process.argv.slice(2);
if (domain === "manifest" && action === "update") await writeManifest();
else if (domain === "manifest" && action === "show") await showManifest();
else if (domain === "config" && action === "write") await writeConfigs();
else if (domain === "config" && action === "show") await showConfigs();
else if (domain === "rollout" && action === "local") await runLocalRollout(rest);
else {
  console.error(
    "Usage: bun benchmarks/swebench/cli.ts <manifest update|manifest show|config write|config show|rollout local --prompt TEXT>",
  );
  process.exitCode = 1;
}
