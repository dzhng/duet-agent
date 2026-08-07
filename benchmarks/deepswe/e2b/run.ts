#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse as parseDotenv } from "dotenv";
import { Sandbox, Template } from "e2b";

import { providerEnvironment, PROVIDER_ENV_NAMES } from "../../shared/provider-environment.js";
import { deepSweMinimumBudgetUsd, DEEPSWE_SINGLE_REQUEST_CUSHION_USD } from "../src/budget.js";
import { DEEPSWE_ARM_NAMES } from "../src/config.js";
import { loadDeepSweManifest } from "../src/manifest.js";
import {
  hasEveryDeepSweArm,
  isRetryableInfrastructureException,
  loadDeepSweResults,
} from "../src/report.js";
import { DEEPSWE_WORKER_COMMAND_TIMEOUT_MS, DEEPSWE_WORKER_TIMEOUT_MS } from "../src/timing.js";
import { deepSweTemplateName, shellQuote } from "./support.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BENCH_ROOT = resolve(import.meta.dir, "..");
const REMOTE_ROOT = "/work/duet-agent";
const REMOTE_ARCHIVE = "/tmp/deepswe-results.tar";
const REMOTE_RESUME_ARCHIVE = "/tmp/deepswe-resume.tar";
const REQUEST_TIMEOUT_MS = 180_000;

interface Options {
  budgetUsd: number;
  costLimitUsd: number;
  concurrency: number;
  taskIds: string[];
  campaign: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await loadRepositoryEnv();
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is required.");
  const providerEnv = providerEnvironment(process.env);
  const [repositorySha, upstreamSha, status] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", "@{upstream}"]),
    git(["status", "--porcelain"]),
  ]);
  if (status) throw new Error("E2B execution requires a clean committed worktree.");
  if (repositorySha !== upstreamSha) {
    throw new Error("E2B execution requires the current commit to be pushed.");
  }
  const manifest = await loadDeepSweManifest(join(BENCH_ROOT, "manifests", "pilot-10-seed-0.json"));
  const taskIds =
    options.taskIds.length === 0
      ? manifest.tasks.map((task) => task.taskId)
      : [...new Set(options.taskIds)];
  for (const taskId of taskIds) {
    if (!manifest.tasks.some((task) => task.taskId === taskId)) {
      throw new Error(`Task is not in the pilot manifest: ${taskId}.`);
    }
  }
  const minimumBudgetUsd = deepSweMinimumBudgetUsd(taskIds.length, options.costLimitUsd);
  if (minimumBudgetUsd > options.budgetUsd) {
    throw new Error(
      `The $${options.budgetUsd.toFixed(2)} budget is below the $${minimumBudgetUsd.toFixed(2)} campaign admission minimum, which includes one $${DEEPSWE_SINGLE_REQUEST_CUSHION_USD.toFixed(2)} in-flight request cushion per rollout. Lower --cost-limit-usd or select fewer tasks.`,
    );
  }

  const templateName = deepSweTemplateName(repositorySha);
  if (!(await Template.exists(templateName, { requestTimeoutMs: REQUEST_TIMEOUT_MS }))) {
    throw new Error(`Missing ${templateName}; run benchmarks/deepswe/e2b/template.ts first.`);
  }
  const outputRoot = join(BENCH_ROOT, "outputs", "e2b", options.campaign);
  await mkdir(outputRoot, { recursive: true });
  await writeCampaignProvenance(join(outputRoot, "campaign.json"), {
    schemaVersion: 1,
    repositorySha,
    deepSweCommit: manifest.upstream.commit,
    pierCommit: manifest.pier.commit,
    taskIds,
    budgetUsd: options.budgetUsd,
    costLimitUsd: options.costLimitUsd,
    singleRequestCushionUsd: DEEPSWE_SINGLE_REQUEST_CUSHION_USD,
    minimumBudgetUsd,
    concurrency: Math.min(options.concurrency, taskIds.length),
  });

  const failures = await runPool(taskIds, options.concurrency, async (taskId) => {
    await runTask({
      taskId,
      campaign: options.campaign,
      outputRoot,
      templateName,
      repositorySha,
      providerEnv,
      costLimitUsd: options.costLimitUsd,
    });
  });
  if (failures.length > 0) {
    throw new Error(`DeepSWE workers failed:\n${failures.join("\n")}`);
  }
  console.log(`Completed ${taskIds.length} DeepSWE task shards under ${outputRoot}.`);
}

interface CampaignProvenance {
  schemaVersion: 1;
  repositorySha: string;
  deepSweCommit: string;
  pierCommit: string;
  taskIds: string[];
  budgetUsd: number;
  costLimitUsd: number;
  singleRequestCushionUsd: number;
  minimumBudgetUsd: number;
  concurrency: number;
}

async function writeCampaignProvenance(
  path: string,
  provenance: CampaignProvenance,
): Promise<void> {
  const existing = await readFile(path, "utf8")
    .then((value) => JSON.parse(value) as CampaignProvenance)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (existing) {
    const immutableExisting = {
      ...existing,
      budgetUsd: 0,
      concurrency: 0,
    };
    const immutableNext = {
      ...provenance,
      budgetUsd: 0,
      concurrency: 0,
    };
    if (JSON.stringify(immutableExisting) !== JSON.stringify(immutableNext)) {
      throw new Error("Refusing to resume a DeepSWE campaign with changed frozen inputs.");
    }
    if (provenance.budgetUsd < existing.budgetUsd) {
      throw new Error("A resumed DeepSWE campaign budget may increase but not decrease.");
    }
  }
  await writeFile(path, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function runTask(input: {
  taskId: string;
  campaign: string;
  outputRoot: string;
  templateName: string;
  repositorySha: string;
  providerEnv: Record<string, string>;
  costLimitUsd: number;
}): Promise<void> {
  const taskOutput = join(input.outputRoot, input.taskId);
  const pruned = await pruneInfrastructureTrials(join(taskOutput, "jobs"));
  if (pruned > 0) {
    console.log(`[${input.taskId}] removed ${pruned} resumable infrastructure result(s).`);
  }
  if (await taskHasAllOutcomes(taskOutput, input.taskId)) {
    console.log(`[${input.taskId}] already has every arm outcome; skipping.`);
    return;
  }
  const sandbox = await Sandbox.create(input.templateName, {
    timeoutMs: DEEPSWE_WORKER_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    envs: input.providerEnv,
    metadata: {
      purpose: "duet-deepswe-pilot",
      campaign: input.campaign,
      taskId: input.taskId,
      repositorySha: input.repositorySha,
    },
  });
  let failure: unknown;
  try {
    const name = `${input.campaign}-${input.taskId}`;
    const resume = await createTaskArchive(taskOutput);
    if (resume) {
      await sandbox.files.write(REMOTE_RESUME_ARCHIVE, resume);
      await sandbox.commands.run(
        `mkdir -p ${shellQuote(`${REMOTE_ROOT}/benchmarks/deepswe/outputs`)} && tar -xf ${REMOTE_RESUME_ARCHIVE} -C ${shellQuote(`${REMOTE_ROOT}/benchmarks/deepswe/outputs`)}`,
        { timeoutMs: 120_000 },
      );
    }
    const command = [
      "bun",
      "benchmarks/deepswe/cli.ts",
      "run",
      "--task",
      input.taskId,
      "--name",
      name,
      "--cost-limit-usd",
      String(input.costLimitUsd),
      "--budget-usd",
      String(deepSweMinimumBudgetUsd(1, input.costLimitUsd)),
      "--concurrency",
      "1",
    ]
      .map(shellQuote)
      .join(" ");
    await sandbox.commands.run(command, {
      cwd: REMOTE_ROOT,
      user: "user",
      timeoutMs: DEEPSWE_WORKER_COMMAND_TIMEOUT_MS,
      onStdout: (line) => console.log(`[${input.taskId}] ${line}`),
      onStderr: (line) => console.error(`[${input.taskId}] ${line}`),
    });
    if (!(await remoteTaskHasAllOutcomes(sandbox, name, input.taskId))) {
      throw new Error(
        `Pier ended without all ${DEEPSWE_ARM_NAMES.length} durable model/verifier outcomes.`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await downloadTaskArchive(sandbox, input.campaign, input.taskId, taskOutput);
    } catch (downloadError) {
      failure ??= downloadError;
    }
    await sandbox.kill().catch(() => false);
  }
  if (failure) throw failure;
}

async function remoteTaskHasAllOutcomes(
  sandbox: Sandbox,
  name: string,
  taskId: string,
): Promise<boolean> {
  const result = await sandbox.commands.run(
    [
      "bun",
      "-e",
      [
        `import { hasEveryDeepSweArm, loadDeepSweResults } from "./benchmarks/deepswe/src/report.ts";`,
        `const rows = await loadDeepSweResults(${JSON.stringify(
          `${REMOTE_ROOT}/benchmarks/deepswe/outputs/jobs/${name}`,
        )});`,
        `process.exit(hasEveryDeepSweArm(rows, ${JSON.stringify(taskId)}) ? 0 : 1);`,
      ].join(" "),
    ]
      .map(shellQuote)
      .join(" "),
    { cwd: REMOTE_ROOT, user: "user", timeoutMs: 120_000 },
  );
  return result.exitCode === 0;
}

async function downloadTaskArchive(
  sandbox: Sandbox,
  campaign: string,
  taskId: string,
  destination: string,
): Promise<void> {
  const name = `${campaign}-${taskId}`;
  await sandbox.commands.run(
    `cd ${shellQuote(`${REMOTE_ROOT}/benchmarks/deepswe/outputs`)} && tar -cf ${REMOTE_ARCHIVE} ${shellQuote(`${name}.json`)} ${shellQuote(`${name}.budget.json`)} ${shellQuote(`jobs/${name}`)}`,
    { timeoutMs: 120_000 },
  );
  const bytes = await sandbox.files.read(REMOTE_ARCHIVE, { format: "bytes" });
  await extractTaskArchive(bytes, destination);
}

async function createTaskArchive(root: string): Promise<Uint8Array | undefined> {
  if (!(await exists(root))) return undefined;
  const temporary = await mkdtemp(join(tmpdir(), "duet-deepswe-resume-"));
  const archive = join(temporary, "resume.tar");
  try {
    await execFileAsync("tar", ["-cf", archive, "-C", root, "."]);
    return await readFile(archive);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function taskHasAllOutcomes(root: string, taskId: string): Promise<boolean> {
  const rows = await loadDeepSweResults(join(root, "jobs"));
  return hasEveryDeepSweArm(rows, taskId);
}

/** Remove only Pier exceptions that its pinned retry policy treats as resumable. */
export async function pruneInfrastructureTrials(jobsRoot: string): Promise<number> {
  const resultPaths = await findResultPaths(jobsRoot);
  let pruned = 0;
  for (const path of resultPaths) {
    const result = JSON.parse(await readFile(path, "utf8")) as {
      task_name?: string;
      agent_info?: { model_info?: { name?: string } };
      exception_info?: { exception_type?: string };
    };
    if (
      result.task_name &&
      result.agent_info?.model_info?.name &&
      isRetryableInfrastructureException(result.exception_info?.exception_type)
    ) {
      await rm(dirname(path), { recursive: true, force: true });
      pruned += 1;
    }
  }
  return pruned;
}

async function findResultPaths(root: string): Promise<string[]> {
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
        if (entry.isDirectory()) return findResultPaths(path);
        return entry.name === "result.json" ? [path] : [];
      }),
    )
  ).flat();
}

async function extractTaskArchive(bytes: Uint8Array, destination: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "duet-deepswe-result-"));
  const archive = join(temporary, "result.tar");
  try {
    await writeFile(archive, bytes);
    const { stdout } = await execFileAsync("tar", ["-tf", archive]);
    for (const entry of stdout.trim().split("\n").filter(Boolean)) {
      if (entry.startsWith("/") || entry.split("/").includes("..")) {
        throw new Error(`Unsafe E2B archive entry: ${entry}`);
      }
    }
    await mkdir(destination, { recursive: true });
    await execFileAsync("tar", ["-xf", archive, "-C", destination]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runPool<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<string[]> {
  const pending = [...values];
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (pending.length > 0) {
        const value = pending.shift();
        if (value === undefined) return;
        try {
          await run(value);
        } catch (error) {
          failures.push(`${String(value)}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }),
  );
  return failures;
}

function parseOptions(args: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const positive = (name: string): number => {
    const parsed = Number(value(name));
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
    return parsed;
  };
  const concurrency = Number(value("--concurrency") ?? "10");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error("--concurrency must be an integer from 1 to 10.");
  }
  const taskIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--task" && args[index + 1]) taskIds.push(args[index + 1]!);
  }
  return {
    budgetUsd: positive("--budget-usd"),
    costLimitUsd: positive("--cost-limit-usd"),
    concurrency,
    taskIds,
    campaign: validateCampaign(value("--campaign") ?? "pilot-10-six-arm"),
  };
}

function validateCampaign(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("--campaign must be a lowercase, path-safe identifier.");
  }
  return value;
}

async function loadRepositoryEnv(): Promise<void> {
  const path = join(REPO_ROOT, ".env");
  const parsed = parseDotenv(await readFile(path, "utf8").catch(() => ""));
  for (const name of ["E2B_API_KEY", ...PROVIDER_ENV_NAMES]) {
    const value = parsed[name];
    if (!process.env[name] && value) process.env[name] = value;
  }
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
