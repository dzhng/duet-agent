#!/usr/bin/env bun
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

import { providerEnvironment, PROVIDER_ENV_NAMES } from "../shared/provider-environment.js";
import { deepSweMinimumBudgetUsd, DEEPSWE_SINGLE_REQUEST_CUSHION_USD } from "./src/budget.js";
import { DEEPSWE_ARM_NAMES, renderDeepSweConfigs, serializeDeepSweConfig } from "./src/config.js";
import {
  loadDeepSweManifest,
  verifyDeepSweCheckout,
  verifyDeepSweSelection,
} from "./src/manifest.js";
import { prepareDeepSweArtifacts, verifyDeepSweArtifacts } from "./src/prepare.js";
import {
  buildDeepSwePairedReport,
  buildDeepSweReport,
  findMissingDeepSweArms,
  loadDeepSweCampaignTaskIds,
  loadDeepSweResults,
} from "./src/report.js";
import { DEEPSWE_AGENT_TIMEOUT_SEC, DEEPSWE_AGENT_WALL_CLOCK_MS } from "./src/timing.js";

const ROOT = import.meta.dir;
const REPO_ROOT = resolve(ROOT, "..", "..");
const CACHE_ROOT = join(ROOT, ".cache");
const DEEPSWE_CHECKOUT = join(CACHE_ROOT, "deep-swe");
const VENV = join(ROOT, ".venv");
const MANIFEST_PATH = join(ROOT, "manifests", "pilot-10-seed-0.json");
const CONFIG_ROOT = join(ROOT, "configs");
const ARTIFACT_ROOT = join(ROOT, "runtime", "build");
const ARTIFACT_MANIFEST_PATH = join(ARTIFACT_ROOT, "artifact-manifest.json");
const JOBS_ROOT = join(ROOT, "outputs", "jobs");

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "configs":
      await writeConfigs();
      return;
    case "setup":
      await setup();
      return;
    case "verify":
      await verify();
      return;
    case "smoke":
      await smoke();
      return;
    case "job":
      await writeJob(args);
      return;
    case "run":
      await run(args);
      return;
    case "report":
      await report(args);
      return;
    default:
      throw new Error(
        "Usage: cli.ts <configs|setup|verify|smoke|job|run|report>. See benchmarks/deepswe/README.md.",
      );
  }
}

async function writeConfigs(): Promise<void> {
  await mkdir(CONFIG_ROOT, { recursive: true });
  for (const [name, config] of Object.entries(renderDeepSweConfigs())) {
    await writeFile(join(CONFIG_ROOT, `${name}.models.json`), serializeDeepSweConfig(config));
  }
  console.log(`Wrote ${DEEPSWE_ARM_NAMES.length} DeepSWE model configurations.`);
}

async function setup(): Promise<void> {
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  await mkdir(CACHE_ROOT, { recursive: true });
  if (!(await exists(join(DEEPSWE_CHECKOUT, ".git")))) {
    await runCommand(["git", "clone", manifest.upstream.repository, DEEPSWE_CHECKOUT]);
  }
  await runCommand(["git", "-C", DEEPSWE_CHECKOUT, "fetch", "origin", manifest.upstream.commit]);
  await runCommand([
    "git",
    "-C",
    DEEPSWE_CHECKOUT,
    "checkout",
    "--detach",
    manifest.upstream.commit,
  ]);
  await runCommand(["git", "-C", DEEPSWE_CHECKOUT, "clean", "-ffd"]);

  await ensurePierVenv();
  await runCommand([
    join(VENV, "bin", "pip"),
    "install",
    "--disable-pip-version-check",
    `git+${manifest.pier.repository}@${manifest.pier.commit}`,
  ]);
  await writeConfigs();
  await prepareDeepSweArtifacts(REPO_ROOT, ARTIFACT_ROOT);
  await verify();
}

async function ensurePierVenv(): Promise<void> {
  const venvPython = join(VENV, "bin", "python");
  if (await exists(venvPython)) {
    const compatible = await commandSucceeds([
      venvPython,
      "-c",
      "import sys; raise SystemExit(not ((3, 12) <= sys.version_info[:2] < (3, 14)))",
    ]);
    if (compatible && (await exists(join(VENV, "bin", "pip")))) return;
    await rm(VENV, { recursive: true, force: true });
  }
  const hostCompatible = await commandSucceeds([
    "python3",
    "-c",
    "import sys; raise SystemExit(not ((3, 12) <= sys.version_info[:2] < (3, 14)))",
  ]);
  if (hostCompatible) {
    await runCommand(["python3", "-m", "venv", VENV]);
    return;
  }
  if (!(await commandSucceeds(["uv", "--version"]))) {
    throw new Error("Pier requires Python 3.12 or 3.13; install one directly or install uv.");
  }
  await runCommand(["uv", "venv", "--python", "3.12", "--seed", VENV]);
}

async function verify(): Promise<void> {
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  await verifyDeepSweCheckout(DEEPSWE_CHECKOUT, manifest);
  await verifyDeepSweSelection(DEEPSWE_CHECKOUT, manifest, join(VENV, "bin", "python"));
  const rendered = renderDeepSweConfigs();
  for (const [name, expected] of Object.entries(rendered)) {
    const actual = JSON.parse(
      await readFile(join(CONFIG_ROOT, `${name}.models.json`), "utf8"),
    ) as unknown;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${name}.models.json is stale; run the configs command.`);
    }
  }
  const pierVersion = (
    await runCommand([
      join(VENV, "bin", "python"),
      "-c",
      "import importlib.metadata; print(importlib.metadata.version('datacurve-pier'))",
    ])
  ).stdout.trim();
  if (pierVersion !== manifest.pier.version) {
    throw new Error(`Pier is ${pierVersion}, expected ${manifest.pier.version}.`);
  }
  await runCommand([join(VENV, "bin", "python"), join(ROOT, "test", "pier_agent_seam.py")], {
    env: pierEnvironment(),
  });
  const artifacts = await verifyDeepSweArtifacts(ARTIFACT_MANIFEST_PATH);
  const repositoryCommit = (await runCommand(["git", "rev-parse", "HEAD"])).stdout.trim();
  if (artifacts.duetCommit !== repositoryCommit) {
    throw new Error(
      `Prepared Duet commit is ${artifacts.duetCommit ?? "missing"}, expected ${repositoryCommit}.`,
    );
  }
  console.log(`DeepSWE pilot setup verified at ${manifest.upstream.commit.slice(0, 12)}.`);
}

async function writeJob(args: string[]): Promise<void> {
  const jobName = option(args, "--name") ?? `deepswe-pilot-${Date.now()}`;
  const task = option(args, "--task");
  const costLimitUsd = positiveOption(args, "--cost-limit-usd");
  const concurrency = Number(option(args, "--concurrency") ?? "4");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 to 16.");
  }
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  const taskIds = task ? [task] : manifest.tasks.map((entry) => entry.taskId);
  for (const taskId of taskIds) {
    if (!manifest.tasks.some((entry) => entry.taskId === taskId)) {
      throw new Error(`Task is not in the pilot manifest: ${taskId}.`);
    }
  }
  const agentEnv = Object.fromEntries(
    Object.keys(providerEnvironment(process.env)).map((name) => [name, `\${${name}}`]),
  );
  const job = {
    job_name: jobName,
    jobs_dir: JOBS_ROOT,
    n_attempts: 1,
    n_concurrent_trials: concurrency,
    // The E2B controller resumes Pier's infrastructure exception classes.
    // Keeping in-process retries off avoids spending twice after a late crash.
    retry: { max_retries: 0 },
    environment: { type: "docker", delete: true },
    agents: DEEPSWE_ARM_NAMES.map((arm) => ({
      import_path: "benchmarks.deepswe.pier_agent:DuetAgent",
      model_name: arm,
      override_timeout_sec: DEEPSWE_AGENT_TIMEOUT_SEC,
      kwargs: {
        routing_config_path: join(CONFIG_ROOT, `${arm}.models.json`),
        artifact_manifest_path: ARTIFACT_MANIFEST_PATH,
        cost_limit_usd: costLimitUsd,
        wall_clock_ms: DEEPSWE_AGENT_WALL_CLOCK_MS,
      },
      env: agentEnv,
    })),
    datasets: [{ path: join(DEEPSWE_CHECKOUT, "tasks"), task_names: taskIds }],
  };
  const output = resolve(option(args, "--output") ?? join(ROOT, "outputs", `${jobName}.json`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(job, null, 2)}\n`);
  console.log(output);
}

async function smoke(): Promise<void> {
  await verify();
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  const taskId = manifest.tasks[0]!.taskId;
  const output = join(ROOT, "outputs", "official-nop-smoke.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        job_name: "deepswe-official-nop-smoke",
        jobs_dir: join(ROOT, "outputs", "smoke"),
        n_attempts: 1,
        n_concurrent_trials: 1,
        retry: { max_retries: 0 },
        environment: { type: "docker", delete: true },
        agents: [{ name: "nop" }],
        datasets: [{ path: join(DEEPSWE_CHECKOUT, "tasks"), task_names: [taskId] }],
      },
      null,
      2,
    )}\n`,
  );
  await runCommand([join(VENV, "bin", "pier"), "run", "--config", output], {
    cwd: REPO_ROOT,
    env: pierEnvironment(),
  });
  console.log(`Official no-model smoke completed for ${taskId}; reward 0 is expected.`);
}

async function run(args: string[]): Promise<void> {
  const budgetUsd = positiveOption(args, "--budget-usd");
  const costLimitUsd = positiveOption(args, "--cost-limit-usd");
  await loadProviderEnvironment();
  providerEnvironment(process.env);
  await verify();
  await requirePushedCleanCommit();
  const task = option(args, "--task");
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  const taskCount = task ? 1 : manifest.tasks.length;
  const minimumBudgetUsd = deepSweMinimumBudgetUsd(taskCount, costLimitUsd);
  if (minimumBudgetUsd > budgetUsd) {
    throw new Error(
      `The $${budgetUsd.toFixed(2)} budget is below the $${minimumBudgetUsd.toFixed(2)} campaign admission minimum, which includes one $${DEEPSWE_SINGLE_REQUEST_CUSHION_USD.toFixed(2)} in-flight request cushion per rollout.`,
    );
  }
  const name = option(args, "--name") ?? `deepswe-pilot-${Date.now()}`;
  const configPath = join(ROOT, "outputs", `${name}.json`);
  await writeJob([
    "--name",
    name,
    "--cost-limit-usd",
    String(costLimitUsd),
    "--concurrency",
    option(args, "--concurrency") ?? "4",
    "--output",
    configPath,
    ...(task ? ["--task", task] : []),
  ]);
  await writeFile(
    join(ROOT, "outputs", `${name}.budget.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        budgetUsd,
        costLimitUsd,
        singleRequestCushionUsd: DEEPSWE_SINGLE_REQUEST_CUSHION_USD,
        minimumBudgetUsd,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Authorized campaign budget: $${budgetUsd.toFixed(2)}.`);
  await runCommand([join(VENV, "bin", "pier"), "run", "--config", configPath], {
    cwd: REPO_ROOT,
    env: pierEnvironment(),
  });
}

async function requirePushedCleanCommit(): Promise<void> {
  const [status, head] = await Promise.all([
    runCommand(["git", "status", "--porcelain"]),
    runCommand(["git", "rev-parse", "HEAD"]),
  ]);
  if (status.stdout.trim()) throw new Error("Paid DeepSWE runs require a clean worktree.");
  const remoteBranches = await runCommand([
    "git",
    "branch",
    "--remotes",
    "--contains",
    head.stdout.trim(),
  ]);
  if (!remoteBranches.stdout.trim()) {
    throw new Error("Paid DeepSWE runs require the current commit on an origin branch.");
  }
}

async function loadProviderEnvironment(): Promise<void> {
  const values = parseDotenv(await readFile(join(REPO_ROOT, ".env"), "utf8").catch(() => ""));
  for (const name of PROVIDER_ENV_NAMES) {
    const value = values[name];
    if (!process.env[name] && value) process.env[name] = value;
  }
}

async function report(args: string[]): Promise<void> {
  const jobs = option(args, "--jobs");
  const campaign = option(args, "--campaign");
  if (jobs && campaign) throw new Error("Use either --jobs or --campaign, not both.");
  if (campaign && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(campaign)) {
    throw new Error("--campaign must be a lowercase, path-safe identifier.");
  }
  const jobsRoot = campaign ? join(ROOT, "outputs", "e2b", campaign) : resolve(jobs ?? JOBS_ROOT);
  const rows = await loadDeepSweResults(jobsRoot);
  const reportRows = buildDeepSweReport(rows);
  const manifest = await loadDeepSweManifest(MANIFEST_PATH);
  const manifestTaskIds = manifest.tasks.map((task) => task.taskId);
  const expectedTaskIds = campaign
    ? await loadDeepSweCampaignTaskIds(jobsRoot, manifestTaskIds)
    : manifestTaskIds;
  const pairs = buildDeepSwePairedReport(rows, expectedTaskIds);
  console.table(
    reportRows.map((row) => ({
      arm: row.arm,
      resolved: `${row.resolved}/${row.completed}`,
      resolveRate: `${(row.resolveRate * 100).toFixed(1)}%`,
      costPerTask: `$${row.costPerTaskUsd.toFixed(2)}`,
      costPerResolved:
        row.costPerResolvedUsd === null ? "—" : `$${row.costPerResolvedUsd.toFixed(2)}`,
    })),
  );
  console.table(
    pairs.map((pair) => ({
      pair: pair.pair,
      completed: pair.completedTasks,
      bothResolved: pair.bothResolved,
      advisorOnly: pair.advisorOnly,
      pureOnlyRegression: pair.pureOnlyRegression,
      neitherResolved: pair.neitherResolved,
      missing: pair.missingArms.length,
    })),
  );
  const output = option(args, "--output");
  if (output) {
    await writeFile(
      resolve(output),
      `${JSON.stringify({ schemaVersion: 1, rows, arms: reportRows, pairs }, null, 2)}\n`,
    );
  }
  const missing = findMissingDeepSweArms(rows, expectedTaskIds).map(
    (entry) => `${entry.taskId}: ${entry.missing.join(", ")}`,
  );
  if (missing.length > 0) {
    throw new Error(`DeepSWE headline is incomplete:\n${missing.join("\n")}`);
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function positiveOption(args: string[], name: string): number {
  const value = Number(option(args, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function runCommand(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(argv, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? processEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (${exitCode}):\n${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function commandSucceeds(argv: string[]): Promise<boolean> {
  const child = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    env: processEnv(),
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function pierEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Python console scripts put their own bin directory on sys.path rather
    // than the working directory; Pier's custom-agent import needs the repo.
    PYTHONPATH: REPO_ROOT,
  };
}

await main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
