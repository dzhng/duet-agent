#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Sandbox, Template } from "e2b";
import { parse as parseDotenv } from "dotenv";

import { e2bTemplateName, shellQuote } from "./support.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BENCH_ROOT = resolve(import.meta.dir, "..");
const REMOTE_REPO_ROOT = "/work/duet-agent";
const REMOTE_PREDICTIONS_ROOT = "/tmp/duet-swebench-score-predictions";
const REMOTE_SCORES_ROOT = "/tmp/duet-swebench-scores";
const REMOTE_ARCHIVE = "/tmp/duet-swebench-scores.tar";
const REQUEST_TIMEOUT_MS = 180_000;

interface PredictionRow {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

interface ScoreRow {
  instanceId: string;
  model: string;
  status: string;
  error?: string;
}

interface ScoringSpec {
  id: string;
  execution?: { backend?: string; workerConcurrency?: number; workerTimeoutMs?: number };
}

interface CampaignProvenance {
  frozen?: { duetGitSha?: unknown };
}

async function main(): Promise<void> {
  await loadEnvironment();
  const specPath = optionValue(process.argv.slice(2), "--spec");
  if (!specPath) throw new Error("--spec is required.");
  const spec = JSON.parse(await readFile(resolve(REPO_ROOT, specPath), "utf8")) as ScoringSpec;
  const provenance = JSON.parse(
    await readFile(join(BENCH_ROOT, "runs", spec.id, "campaign.json"), "utf8"),
  ) as CampaignProvenance;
  const workerSha = provenance.frozen?.duetGitSha;
  if (typeof workerSha !== "string" || !/^[0-9a-f]{40}$/.test(workerSha)) {
    throw new Error("Campaign provenance has no frozen worker SHA.");
  }
  const templateName = e2bTemplateName(workerSha);
  if (!(await Template.exists(templateName, { requestTimeoutMs: REQUEST_TIMEOUT_MS }))) {
    throw new Error(`E2B template ${templateName} is missing.`);
  }

  const cacheRoot = join(BENCH_ROOT, ".cache", spec.id);
  const predictionRoot = join(cacheRoot, "predictions");
  const outputRoot = join(cacheRoot, "scores");
  const rows = await loadPredictions(predictionRoot);
  const rowsByInstance = Map.groupBy(rows, (row) => row.instance_id);
  const cached = await loadCachedResults(outputRoot);
  const pending = [...rowsByInstance].filter(([instanceId, expected]) => {
    const existing = cached.filter((row) => row.instanceId === instanceId);
    return existing.length !== expected.length;
  });
  const concurrency = spec.execution?.workerConcurrency ?? 16;
  const timeoutMs = spec.execution?.workerTimeoutMs ?? 10_800_000;
  console.log(
    `Scoring ${pending.length} task shard(s) with up to ${concurrency} E2B worker(s); ${cached.length} prediction(s) cached.`,
  );

  const fresh = await runPool(pending, concurrency, async ([instanceId, instanceRows]) => {
    try {
      const results = await scoreInstance({
        campaignId: spec.id,
        instanceId,
        rows: instanceRows,
        templateName,
        timeoutMs,
        outputRoot,
      });
      console.log(`scored ${instanceId}: ${results.map((row) => row.status).join(", ")}`);
      return results;
    } catch (error) {
      const message = errorMessage(error);
      console.error(`score failed ${instanceId}: ${message}`);
      return instanceRows.map((row) => ({
        instanceId,
        model: row.model_name_or_path,
        status: "infra_error",
        error: message,
      }));
    }
  });
  const results = [...cached, ...fresh.flat()].sort((left, right) =>
    `${left.instanceId}\0${left.model}`.localeCompare(`${right.instanceId}\0${right.model}`),
  );
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    join(outputRoot, "summary.json"),
    `${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`,
  );
  const failures = results.filter((row) =>
    ["infra_error", "missing", "error"].includes(row.status),
  );
  console.log(
    `Scored ${results.length} prediction(s); ${failures.length} infrastructure/error result(s).`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

async function scoreInstance(input: {
  campaignId: string;
  instanceId: string;
  rows: PredictionRow[];
  templateName: string;
  timeoutMs: number;
  outputRoot: string;
}): Promise<ScoreRow[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sandbox = await Sandbox.create(input.templateName, {
      timeoutMs: input.timeoutMs,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      metadata: {
        purpose: "duet-swebench-score",
        campaign: input.campaignId,
        instanceId: input.instanceId,
        attempt: String(attempt),
      },
    });
    try {
      const predictions = `${input.rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
      await sandbox.commands.run(
        `rm -rf ${shellQuote(REMOTE_PREDICTIONS_ROOT)} ${shellQuote(REMOTE_SCORES_ROOT)}; mkdir -p ${shellQuote(REMOTE_PREDICTIONS_ROOT)} ${shellQuote(REMOTE_SCORES_ROOT)}`,
      );
      await sandbox.files.write(`${REMOTE_PREDICTIONS_ROOT}/predictions.jsonl`, predictions);
      let scoringError: unknown;
      try {
        await sandbox.commands.run(
          [
            `${REMOTE_REPO_ROOT}/benchmarks/swebench/.venv/bin/python`,
            `${REMOTE_REPO_ROOT}/benchmarks/swebench/mac/score_predictions.py`,
            "--predictions-dir",
            REMOTE_PREDICTIONS_ROOT,
            "--output-dir",
            REMOTE_SCORES_ROOT,
          ]
            .map(shellQuote)
            .join(" "),
          { timeoutMs: input.timeoutMs - 60_000 },
        );
      } catch (error) {
        scoringError = error;
      }
      try {
        await sandbox.commands.run(
          `test -f ${shellQuote(`${REMOTE_SCORES_ROOT}/summary.json`)}; cd ${shellQuote(REMOTE_SCORES_ROOT)}; tar -cf ${shellQuote(REMOTE_ARCHIVE)} .`,
        );
      } catch {
        throw scoringError ?? new Error("Scorer produced no summary.");
      }
      const bytes = await sandbox.files.read(REMOTE_ARCHIVE, { format: "bytes" });
      return await installScoringArchive(bytes, input.outputRoot);
    } catch (error) {
      lastError = error;
    } finally {
      await sandbox.kill().catch(() => false);
    }
  }
  throw lastError;
}

async function installScoringArchive(bytes: Uint8Array, outputRoot: string): Promise<ScoreRow[]> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "duet-swebench-score-"));
  const archive = join(temporaryRoot, "scores.tar");
  const extracted = join(temporaryRoot, "extracted");
  try {
    await writeFile(archive, bytes);
    const { stdout } = await execFileAsync("tar", ["-tf", archive]);
    for (const entry of stdout.split("\n").filter(Boolean)) {
      if (entry.startsWith("/") || entry.split("/").includes("..")) {
        throw new Error(`Unsafe scoring artifact path: ${entry}.`);
      }
    }
    await mkdir(extracted);
    await execFileAsync("tar", ["-xf", archive, "-C", extracted]);
    const summary = JSON.parse(await readFile(join(extracted, "summary.json"), "utf8")) as {
      results?: ScoreRow[];
    };
    if (!Array.isArray(summary.results)) throw new Error("Scorer summary has no results array.");
    for (const entry of await readdir(extracted, { withFileTypes: true })) {
      if (entry.name === "summary.json") continue;
      await copyTree(join(extracted, entry.name), join(outputRoot, entry.name));
    }
    return summary.results;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) {
      const temporary = join(
        dirname(destinationPath),
        `.${basename(destinationPath)}-${randomUUID()}`,
      );
      await copyFile(sourcePath, temporary);
      await rename(temporary, destinationPath);
    } else throw new Error(`Unsupported scoring artifact: ${sourcePath}.`);
  }
}

async function loadPredictions(root: string): Promise<PredictionRow[]> {
  const rows: PredictionRow[] = [];
  for (const name of (await readdir(root))
    .filter((candidate) => candidate.endsWith(".jsonl"))
    .sort()) {
    for (const line of (await readFile(join(root, name), "utf8")).split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line) as PredictionRow);
    }
  }
  return rows;
}

async function loadCachedResults(outputRoot: string): Promise<ScoreRow[]> {
  try {
    const summary = JSON.parse(await readFile(join(outputRoot, "summary.json"), "utf8")) as {
      results?: ScoreRow[];
    };
    return Array.isArray(summary.results) ? summary.results : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function runPool<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(values.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await run(values[index]!);
      }
    }),
  );
  return results;
}

async function loadEnvironment(): Promise<void> {
  const values = parseDotenv(await readFile(join(REPO_ROOT, ".env"), "utf8"));
  if (!process.env.E2B_API_KEY && values.E2B_API_KEY) process.env.E2B_API_KEY = values.E2B_API_KEY;
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not configured.");
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
