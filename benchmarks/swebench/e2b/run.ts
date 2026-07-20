#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Sandbox, Template, type SandboxMetrics } from "e2b";
import { parse as parseDotenv } from "dotenv";

import { PGLITE_RUNTIME_ASSET_NAMES } from "../../../src/memory/pglite.js";
import { loadRolloutAttempts, type RolloutAttempt } from "../src/artifacts.js";
import type { InstanceManifest } from "../src/manifest.js";
import type { CampaignSpec } from "../src/orchestrator.js";
import {
  buildE2BEnvironmentLock,
  e2bTemplateName,
  providerEnvironment,
  shellQuote,
  type E2BEnvironmentProbe,
} from "./support.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const BENCH_ROOT = resolve(import.meta.dir, "..");
const REMOTE_REPO_ROOT = "/work/duet-agent";
const DEFAULT_SPEC = "benchmarks/swebench/campaigns/multilingual-30-four-arm-e2b-v4.json";
const REMOTE_ENVIRONMENT_LOCK = "/tmp/duet-swebench-environment.lock.json";
const REMOTE_RESUME_ARCHIVE = "/tmp/duet-swebench-resume.tar";
const REMOTE_RESULT_ARCHIVE = "/tmp/duet-swebench-result.tar";
const REMOTE_PREBUILT_ARTIFACT = `${REMOTE_REPO_ROOT}/benchmarks/swebench/runtime/build/duet-linux-x64`;
const REMOTE_RUNTIME_ASSETS = PGLITE_RUNTIME_ASSET_NAMES.map(
  (name) => `${REMOTE_REPO_ROOT}/benchmarks/swebench/runtime/build/${name}`,
);
const E2B_REQUEST_TIMEOUT_MS = 180_000;
const E2B_CREATE_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const E2B_READ_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

interface DriverOptions {
  specPath: string;
  instanceIds: string[];
  capacityOnly: boolean;
  retryFailed: boolean;
}

interface E2BCampaignSpec extends CampaignSpec {
  execution: Extract<NonNullable<CampaignSpec["execution"]>, { backend: "e2b" }>;
}

interface WorkerRecord {
  instanceId: string;
  sandboxId: string;
  startedAt: string;
  finishedAt: string;
  commandSucceeded: boolean;
  metrics: SandboxMetrics[];
  error?: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await loadRepositoryEnvironment();
  if (!options.capacityOnly) providerEnvironment(process.env);
  const specAbsolutePath = resolve(REPO_ROOT, options.specPath);
  const spec = JSON.parse(await readFile(specAbsolutePath, "utf8")) as CampaignSpec;
  if (spec.execution?.backend !== "e2b") {
    throw new Error(`Campaign ${spec.id} does not declare the E2B execution backend.`);
  }
  const e2bSpec = spec as E2BCampaignSpec;
  if (e2bSpec.concurrency !== 1) {
    throw new Error("Each E2B worker must retain campaign concurrency 1 inside its sandbox.");
  }
  if (e2bSpec.execution.workerTimeoutMs <= 60_000) {
    throw new Error("E2B worker timeout must leave at least one minute for artifact collection.");
  }

  const [repositorySha, originMainSha, status, manifest] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"]),
    gitOutput(["rev-parse", "origin/main"]),
    gitOutput(["status", "--porcelain"]),
    readManifest(e2bSpec),
  ]);
  if (status) throw new Error("E2B campaign execution requires a clean committed worktree.");
  if (repositorySha !== originMainSha) {
    throw new Error("E2B campaign execution requires HEAD to equal pushed origin/main.");
  }
  await assertCampaignBudgetBound(e2bSpec, manifest, options.retryFailed);

  const templateName = e2bTemplateName(repositorySha);
  const templateExists = await retryE2BRead(() => Template.exists(templateName));
  if (!templateExists) {
    throw new Error(`E2B template ${templateName} is missing; run e2b/template.ts first.`);
  }
  const cacheRoot = join(BENCH_ROOT, ".cache", e2bSpec.id, "e2b");
  await mkdir(cacheRoot, { recursive: true });
  const environmentLock = await capacityProbe(e2bSpec, repositorySha, templateName, cacheRoot);
  if (options.capacityOnly) return;

  const instanceIds = selectE2BInstanceIds(e2bSpec, manifest, options.instanceIds);
  console.log(
    `Launching ${instanceIds.length} instance block(s) with ${e2bSpec.execution.workerConcurrency} E2B worker(s).`,
  );
  const failures = await runPool(
    instanceIds,
    e2bSpec.execution.workerConcurrency,
    async (instanceId) => {
      try {
        await runInstanceBlock({
          spec: e2bSpec,
          specPath: relative(REPO_ROOT, specAbsolutePath),
          repositorySha,
          templateName,
          environmentLock,
          cacheRoot,
          instanceId,
          retryFailed: options.retryFailed,
        });
        return undefined;
      } catch (error) {
        return `${instanceId}: ${errorMessage(error)}`;
      }
    },
  );
  if (failures.length > 0) {
    throw new Error(
      `E2B campaign left ${failures.length} failed block(s):\n${failures.join("\n")}`,
    );
  }
  console.log(`E2B campaign ${e2bSpec.id} finished all requested instance blocks.`);
}

/** Resolve the committed campaign population, optionally narrowed to an explicit shard. */
export function selectE2BInstanceIds(
  spec: CampaignSpec,
  manifest: InstanceManifest,
  requestedInstanceIds: readonly string[],
): string[] {
  const known = new Set(manifest.entries.map((entry) => entry.instanceId));
  const campaignInstanceIds = [
    ...new Set(spec.instanceIds ?? manifest.entries.map((entry) => entry.instanceId)),
  ];
  for (const instanceId of campaignInstanceIds) {
    if (!known.has(instanceId)) throw new Error(`Instance is not in the manifest: ${instanceId}.`);
    pathSafeInstance(instanceId);
  }
  if (requestedInstanceIds.length === 0) return campaignInstanceIds;

  const selected = new Set(campaignInstanceIds);
  const requested = [...new Set(requestedInstanceIds)];
  for (const instanceId of requested) {
    if (!known.has(instanceId)) throw new Error(`Instance is not in the manifest: ${instanceId}.`);
    if (!selected.has(instanceId)) {
      throw new Error(`Instance is not selected by the campaign: ${instanceId}.`);
    }
    pathSafeInstance(instanceId);
  }
  return requested;
}

/** Retry read-only E2B controller requests that cannot create billable model work. */
export async function retryE2BRead<T>(
  read: () => Promise<T>,
  retryDelaysMs: readonly number[] = E2B_READ_RETRY_DELAYS_MS,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

async function capacityProbe(
  spec: E2BCampaignSpec,
  repositorySha: string,
  templateName: string,
  cacheRoot: string,
): Promise<string> {
  console.log(`Probing ${templateName} before launching model work.`);
  const metadata = {
    purpose: "duet-swebench-capacity",
    campaign: spec.id,
    repositorySha,
  };
  const sandbox = await retryE2BSandboxCreate(
    () =>
      Sandbox.create(templateName, {
        timeoutMs: 10 * 60_000,
        requestTimeoutMs: E2B_REQUEST_TIMEOUT_MS,
        metadata,
      }),
    () => killOwnedSandboxes(metadata),
  );
  const startedAt = new Date().toISOString();
  try {
    const commandOptions = { timeoutMs: 120_000 };
    const info = await sandbox.getInfo();
    const shaResult = await sandbox.commands.run("git rev-parse HEAD", {
      ...commandOptions,
      cwd: REMOTE_REPO_ROOT,
    });
    const architecture = await sandbox.commands.run("uname -m", commandOptions);
    const osRelease = await sandbox.commands.run(
      ". /etc/os-release && printf '%s' \"$PRETTY_NAME\"",
      commandOptions,
    );
    const dockerClientVersion = await sandbox.commands.run(
      "docker version --format '{{.Client.Version}}'",
      commandOptions,
    );
    const dockerServerVersion = await sandbox.commands.run(
      "docker version --format '{{.Server.Version}}'",
      commandOptions,
    );
    const duetArtifactHash = await sandbox.commands.run(
      `sha256sum ${shellQuote(REMOTE_PREBUILT_ARTIFACT)}`,
      commandOptions,
    );
    const runtimeAssetHashes = await sandbox.commands.run(
      `sha256sum ${REMOTE_RUNTIME_ASSETS.map(shellQuote).join(" ")}`,
      commandOptions,
    );
    const compiledMemorySmoke = await sandbox.commands.run(
      `HOME=/tmp/duet-swebench-capacity-home ${shellQuote(REMOTE_PREBUILT_ARTIFACT)} memory --json`,
      commandOptions,
    );
    const pythonVersion = await sandbox.commands.run(
      `${REMOTE_REPO_ROOT}/benchmarks/swebench/.venv/bin/python --version`,
      commandOptions,
    );
    const swebenchVersion = await sandbox.commands.run(
      `${REMOTE_REPO_ROOT}/benchmarks/swebench/.venv/bin/python -c "import importlib.metadata; print(importlib.metadata.version('swebench'))"`,
      commandOptions,
    );
    if (shaResult.stdout.trim() !== repositorySha) {
      throw new Error(
        `Template repository SHA is ${shaResult.stdout.trim()}, expected ${repositorySha}.`,
      );
    }
    if (info.cpuCount !== spec.execution.workerCpuCount) {
      throw new Error(
        `E2B worker has ${info.cpuCount} CPUs, expected ${spec.execution.workerCpuCount}.`,
      );
    }
    if (info.memoryMB !== spec.execution.workerMemoryMb) {
      throw new Error(
        `E2B worker has ${info.memoryMB} MiB, expected ${spec.execution.workerMemoryMb}.`,
      );
    }
    const dockerClient = dockerClientVersion.stdout.trim();
    const dockerServer = dockerServerVersion.stdout.trim();
    if (!dockerClient || !dockerServer) {
      throw new Error("E2B Docker capacity probe did not return client and server versions.");
    }
    const duetArtifactSha256 = duetArtifactHash.stdout.trim().split(/\s+/, 1)[0];
    if (!duetArtifactSha256 || !/^[0-9a-f]{64}$/.test(duetArtifactSha256)) {
      throw new Error("E2B capacity probe did not return the prebuilt Duet artifact hash.");
    }
    const runtimeAssetSha256 = parseRuntimeAssetHashes(runtimeAssetHashes.stdout);
    if (compiledMemorySmoke.exitCode !== 0) {
      throw new Error(
        `Compiled Duet could not open default memory: ${compiledMemorySmoke.stderr || compiledMemorySmoke.stdout}`,
      );
    }
    try {
      if (!Array.isArray(JSON.parse(compiledMemorySmoke.stdout))) throw new Error("not an array");
    } catch {
      throw new Error("Compiled Duet memory smoke did not return its JSON row array.");
    }
    const probe: E2BEnvironmentProbe = {
      templateName,
      templateId: info.templateId,
      cpuCount: info.cpuCount,
      memoryMb: info.memoryMB,
      repositorySha,
      architecture: architecture.stdout.trim(),
      osRelease: osRelease.stdout.trim(),
      dockerClientVersion: dockerClient,
      dockerServerVersion: dockerServer,
      duetArtifactSha256,
      runtimeAssetSha256,
      pythonVersion: pythonVersion.stdout.trim().replace(/^Python\s+/, ""),
      swebenchVersion: swebenchVersion.stdout.trim(),
    };
    const environmentLock = `${JSON.stringify(buildE2BEnvironmentLock(probe), null, 2)}\n`;
    await verifyPrebuiltArtifactReplica(spec, repositorySha, templateName, {
      duetArtifactSha256,
      runtimeAssetSha256,
    });
    await Promise.all([
      writeFile(join(cacheRoot, "environment.lock.json"), environmentLock),
      writeFile(
        join(cacheRoot, "capacity.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            sandboxId: sandbox.sandboxId,
            startedAt,
            finishedAt: new Date().toISOString(),
            probe,
          },
          null,
          2,
        )}\n`,
      ),
    ]);
    console.log(
      `Capacity gate passed: ${info.cpuCount} vCPU, ${info.memoryMB} MiB, ${probe.architecture}, Docker ${dockerServer}, Duet ${duetArtifactSha256.slice(0, 12)} on two fresh workers.`,
    );
    return environmentLock;
  } finally {
    await sandbox.kill().catch(() => false);
  }
}

async function verifyPrebuiltArtifactReplica(
  spec: E2BCampaignSpec,
  repositorySha: string,
  templateName: string,
  expected: Pick<E2BEnvironmentProbe, "duetArtifactSha256" | "runtimeAssetSha256">,
): Promise<void> {
  const metadata = {
    purpose: "duet-swebench-capacity-replica",
    campaign: spec.id,
    repositorySha,
  };
  const sandbox = await retryE2BSandboxCreate(
    () =>
      Sandbox.create(templateName, {
        timeoutMs: 10 * 60_000,
        requestTimeoutMs: E2B_REQUEST_TIMEOUT_MS,
        metadata,
      }),
    () => killOwnedSandboxes(metadata),
  );
  try {
    const result = await sandbox.commands.run(
      `sha256sum ${[REMOTE_PREBUILT_ARTIFACT, ...REMOTE_RUNTIME_ASSETS].map(shellQuote).join(" ")}`,
      { timeoutMs: 120_000 },
    );
    const [artifactLine, ...runtimeLines] = result.stdout.trim().split("\n");
    const actualArtifactSha256 = artifactLine?.trim().split(/\s+/, 1)[0];
    const actualRuntimeSha256 = parseRuntimeAssetHashes(runtimeLines.join("\n"));
    if (
      actualArtifactSha256 !== expected.duetArtifactSha256 ||
      JSON.stringify(actualRuntimeSha256) !== JSON.stringify(expected.runtimeAssetSha256)
    ) {
      throw new Error("E2B template artifact bundle differs across fresh workers.");
    }
  } finally {
    await sandbox.kill().catch(() => false);
  }
}

function parseRuntimeAssetHashes(stdout: string): E2BEnvironmentProbe["runtimeAssetSha256"] {
  const parsed = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha256, path] = line.trim().split(/\s+/, 2);
        return [path ? path.split("/").at(-1) : undefined, sha256];
      }),
  );
  for (const name of PGLITE_RUNTIME_ASSET_NAMES) {
    if (!parsed[name] || !/^[0-9a-f]{64}$/.test(parsed[name])) {
      throw new Error(`E2B capacity probe did not return the PGlite ${name} hash.`);
    }
  }
  return parsed as E2BEnvironmentProbe["runtimeAssetSha256"];
}

async function runInstanceBlock(input: {
  spec: E2BCampaignSpec;
  specPath: string;
  repositorySha: string;
  templateName: string;
  environmentLock: string;
  cacheRoot: string;
  instanceId: string;
  retryFailed: boolean;
}): Promise<void> {
  const startedAt = new Date().toISOString();
  const metadata = {
    purpose: "duet-swebench-worker",
    campaign: input.spec.id,
    instanceId: input.instanceId,
    repositorySha: input.repositorySha,
  };
  const sandbox = await retryE2BSandboxCreate(
    () =>
      Sandbox.create(input.templateName, {
        timeoutMs: input.spec.execution.workerTimeoutMs,
        requestTimeoutMs: E2B_REQUEST_TIMEOUT_MS,
        envs: {
          ...providerEnvironment(process.env),
          DUET_SWEBENCH_PREBUILT_ARTIFACT: REMOTE_PREBUILT_ARTIFACT,
        },
        metadata,
      }),
    () => killOwnedSandboxes(metadata),
  );
  let commandSucceeded = false;
  let failure: unknown;
  let metrics: SandboxMetrics[] = [];
  try {
    await sandbox.files.write(REMOTE_ENVIRONMENT_LOCK, input.environmentLock);
    const resume = await createResumeArchive(input.spec, input.instanceId);
    if (resume) {
      await sandbox.files.write(REMOTE_RESUME_ARCHIVE, resume);
      await sandbox.commands.run(
        `mkdir -p ${shellQuote(remoteCampaignRoot(input.spec.id))} && tar -xf ${shellQuote(REMOTE_RESUME_ARCHIVE)} -C ${shellQuote(remoteCampaignRoot(input.spec.id))}`,
      );
    }

    const command = [
      "bun",
      "benchmarks/swebench/cli.ts",
      "campaign",
      "run",
      "--spec",
      input.specPath,
      "--instance",
      input.instanceId,
      "--environment-lock",
      REMOTE_ENVIRONMENT_LOCK,
      ...(input.retryFailed ? ["--retry-failed"] : []),
    ]
      .map(shellQuote)
      .join(" ");
    await sandbox.commands.run(command, {
      cwd: REMOTE_REPO_ROOT,
      user: "user",
      timeoutMs: input.spec.execution.workerTimeoutMs - 60_000,
      onStdout: lineLogger(input.instanceId, "out"),
      onStderr: lineLogger(input.instanceId, "err"),
    });
    commandSucceeded = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await downloadInstanceArtifacts(sandbox, input.spec, input.instanceId);
    } catch (error) {
      failure ??= error;
    }
    metrics = await sandbox.getMetrics().catch(() => []);
    const record: WorkerRecord = {
      instanceId: input.instanceId,
      sandboxId: sandbox.sandboxId,
      startedAt,
      finishedAt: new Date().toISOString(),
      commandSucceeded,
      metrics,
      ...(failure ? { error: errorMessage(failure) } : {}),
    };
    const workersRoot = join(input.cacheRoot, "workers");
    await mkdir(workersRoot, { recursive: true });
    await writeFile(
      join(workersRoot, `${pathSafeInstance(input.instanceId)}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await sandbox.kill().catch(() => false);
  }
  if (failure) throw failure;
}

/** Retry controller-level sandbox creation before any model command can run. */
export async function retryE2BSandboxCreate<T>(
  create: () => Promise<T>,
  cleanup: () => Promise<void>,
  retryDelaysMs: readonly number[] = E2B_CREATE_RETRY_DELAYS_MS,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await create();
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) throw error;
      await cleanup().catch(() => undefined);
      await sleep(delay);
    }
  }
}

async function killOwnedSandboxes(metadata: Record<string, string>): Promise<void> {
  const paginator = Sandbox.list({
    query: { metadata, state: ["running"] },
    requestTimeoutMs: E2B_REQUEST_TIMEOUT_MS,
  });
  while (paginator.hasNext) {
    for (const sandbox of await paginator.nextItems()) {
      await Sandbox.kill(sandbox.sandboxId, { requestTimeoutMs: E2B_REQUEST_TIMEOUT_MS });
    }
  }
}

async function createResumeArchive(
  spec: E2BCampaignSpec,
  instanceId: string,
): Promise<ArrayBuffer | undefined> {
  const campaignRoot = hostCampaignRoot(spec.id);
  const entries = await existingInstanceEntries(campaignRoot, spec, instanceId);
  if (entries.length === 0) return undefined;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "duet-swebench-resume-"));
  const archivePath = join(temporaryRoot, "resume.tar");
  try {
    await execFileAsync("tar", ["-cf", archivePath, "-C", campaignRoot, ...entries]);
    const bytes = await readFile(archivePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function downloadInstanceArtifacts(
  sandbox: Sandbox,
  spec: E2BCampaignSpec,
  instanceId: string,
): Promise<void> {
  const campaignRoot = remoteCampaignRoot(spec.id);
  const candidates = campaignArtifactRoots(spec, instanceId);
  const quotedCandidates = candidates.map(shellQuote).join(" ");
  await sandbox.commands.run(
    `set -eu; set --; cd ${shellQuote(campaignRoot)}; for item in ${quotedCandidates}; do if [ -e "$item" ]; then set -- "$@" "$item"; fi; done; [ "$#" -gt 0 ]; tar -cf ${shellQuote(REMOTE_RESULT_ARCHIVE)} "$@"`,
  );
  const bytes = await sandbox.files.read(REMOTE_RESULT_ARCHIVE, { format: "bytes" });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "duet-swebench-result-"));
  const archivePath = join(temporaryRoot, "result.tar");
  const extractedRoot = join(temporaryRoot, "extracted");
  try {
    await writeFile(archivePath, bytes);
    const { stdout } = await execFileAsync("tar", ["-tf", archivePath]);
    validateArchiveEntries(stdout.split("\n").filter(Boolean), spec, instanceId);
    await mkdir(extractedRoot);
    await execFileAsync("tar", ["-xf", archivePath, "-C", extractedRoot]);
    await integrateInstanceArtifacts(extractedRoot, hostCampaignRoot(spec.id), spec, instanceId);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Install one worker's staged output while preserving immutable campaign provenance. */
export async function integrateInstanceArtifacts(
  extractedRoot: string,
  destinationRoot: string,
  spec: CampaignSpec,
  instanceId: string,
): Promise<void> {
  pathSafeInstance(instanceId);
  await mkdir(destinationRoot, { recursive: true });
  await installCampaignProvenance(
    join(extractedRoot, "campaign.json"),
    join(destinationRoot, "campaign.json"),
  );

  for (const candidate of instanceArtifactRoots(spec, instanceId)) {
    const source = join(extractedRoot, candidate);
    try {
      await access(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await copyArtifactTree(source, join(destinationRoot, candidate));
  }
}

async function installCampaignProvenance(source: string, destination: string): Promise<void> {
  const sourceBytes = await readFile(source);
  const temporary = join(dirname(destination), `.campaign-${randomUUID()}.json`);
  await writeFile(temporary, sourceBytes, { flag: "wx" });
  try {
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingBytes = await readFile(destination);
      if (!sameCampaignProvenance(existingBytes, sourceBytes)) {
        throw new Error("E2B worker campaign provenance does not match existing campaign.json.");
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function sameCampaignProvenance(leftBytes: Buffer, rightBytes: Buffer): boolean {
  try {
    const left = JSON.parse(leftBytes.toString("utf8")) as CampaignProvenanceIdentity;
    const right = JSON.parse(rightBytes.toString("utf8")) as CampaignProvenanceIdentity;
    return (
      left.schemaVersion === right.schemaVersion &&
      left.inputHash === right.inputHash &&
      JSON.stringify(left.frozen) === JSON.stringify(right.frozen)
    );
  } catch {
    return leftBytes.equals(rightBytes);
  }
}

interface CampaignProvenanceIdentity {
  schemaVersion?: unknown;
  inputHash?: unknown;
  frozen?: unknown;
}

async function copyArtifactTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  // A rollout status is its completion marker, so publish it only after its evidence files.
  entries.sort((left, right) => {
    if (left.name === "status.json") return 1;
    if (right.name === "status.json") return -1;
    return left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyArtifactTree(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported E2B artifact entry: ${sourcePath}.`);
    }
    const temporary = `${destinationPath}.tmp-${randomUUID()}`;
    try {
      await copyFile(sourcePath, temporary);
      await rename(temporary, destinationPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function campaignArtifactRoots(spec: CampaignSpec, instanceId: string): string[] {
  return ["campaign.json", ...instanceArtifactRoots(spec, instanceId)];
}

function instanceArtifactRoots(spec: CampaignSpec, instanceId: string): string[] {
  return spec.configs.flatMap((config) =>
    Array.from({ length: spec.trials }, (_, index) => `${config}/${instanceId}-t${index + 1}`),
  );
}

function validateArchiveEntries(
  entries: readonly string[],
  spec: E2BCampaignSpec,
  instanceId: string,
): void {
  const allowed = campaignArtifactRoots(spec, instanceId);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`Unsafe E2B artifact path: ${entry}.`);
    }
    if (!allowed.some((root) => entry === root || entry.startsWith(`${root}/`))) {
      throw new Error(`Unexpected E2B artifact path: ${entry}.`);
    }
  }
}

async function existingInstanceEntries(
  campaignRoot: string,
  spec: E2BCampaignSpec,
  instanceId: string,
): Promise<string[]> {
  const candidates = campaignArtifactRoots(spec, instanceId);
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(join(campaignRoot, candidate));
      existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

async function runPool<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<string | undefined>,
): Promise<string[]> {
  let next = 0;
  const failures: string[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      const value = values[index];
      if (value === undefined) return;
      const failure = await run(value);
      if (failure) failures.push(failure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return failures;
}

async function assertCampaignBudgetBound(
  spec: E2BCampaignSpec,
  manifest: InstanceManifest,
  retryFailed: boolean,
): Promise<void> {
  const attempts = await loadRolloutAttempts(join(BENCH_ROOT, "runs"), spec.id);
  const { pending, priorUsd, totalUsd } = calculateCampaignBudgetBound(
    spec,
    manifest,
    attempts,
    retryFailed,
  );
  if (totalUsd > spec.budget.totalUsd + Number.EPSILON) {
    throw new Error(
      `Global campaign budget bound is $${totalUsd.toFixed(4)}, above $${spec.budget.totalUsd.toFixed(2)}.`,
    );
  }
  console.log(
    `Global model-spend bound: $${spec.budget.sunkUsd.toFixed(2)} sunk + $${priorUsd.toFixed(4)} prior + ${pending} × $${spec.limits.costUsd.toFixed(2)} = $${totalUsd.toFixed(4)}.`,
  );
}

/** Worst-case campaign model spend across completed, crashed, and pending attempts. */
export function calculateCampaignBudgetBound(
  spec: CampaignSpec,
  manifest: InstanceManifest,
  attempts: readonly RolloutAttempt[],
  retryFailed: boolean,
): { pending: number; priorUsd: number; totalUsd: number } {
  const attemptsByArm = new Map<string, RolloutAttempt[]>();
  for (const attempt of attempts) {
    const key = armKey(attempt.spec.instanceId, attempt.spec.config, attempt.spec.trial);
    const existing = attemptsByArm.get(key);
    if (existing) existing.push(attempt);
    else attemptsByArm.set(key, [attempt]);
  }

  let pending = 0;
  const selected = new Set(spec.instanceIds ?? manifest.entries.map((entry) => entry.instanceId));
  for (const entry of manifest.entries) {
    if (!selected.has(entry.instanceId)) continue;
    for (let trial = 1; trial <= spec.trials; trial += 1) {
      for (const config of spec.configs) {
        const logicalAttempts = attemptsByArm.get(armKey(entry.instanceId, config, trial)) ?? [];
        if (logicalAttempts.some((attempt) => attempt.status.phase === "completed")) continue;
        const latest = [...logicalAttempts].sort(
          (left, right) => right.status.attempt - left.status.attempt,
        )[0];
        if (
          latest?.status.phase === "failed" &&
          (latest.status.failureKind !== "infra" || !retryFailed)
        ) {
          continue;
        }
        pending += 1;
      }
    }
  }

  const prior = attempts.reduce((total, attempt) => {
    if (attempt.status.costUsd !== undefined) return total + attempt.status.costUsd;
    if (attempt.status.phase === "running" || attempt.status.failureKind === "infra") {
      return total + attempt.spec.limits.costUsd;
    }
    return total;
  }, 0);
  return {
    pending,
    priorUsd: prior,
    totalUsd: spec.budget.sunkUsd + prior + pending * spec.limits.costUsd,
  };
}

function armKey(instanceId: string, config: string, trial: number): string {
  return `${instanceId}\0${config}\0${trial}`;
}

async function loadRepositoryEnvironment(): Promise<void> {
  try {
    const values = parseDotenv(await readFile(join(REPO_ROOT, ".env"), "utf8"));
    for (const name of [
      "E2B_API_KEY",
      "DUET_API_KEY",
      "AI_GATEWAY_API_KEY",
      "OPENROUTER_API_KEY",
    ] as const) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not configured.");
}

function parseOptions(args: readonly string[]): DriverOptions {
  const valueFlags = new Set(["--spec", "--instance"]);
  const booleanFlags = new Set(["--capacity-only", "--retry-failed"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!booleanFlags.has(argument)) throw new Error(`Unknown E2B option: ${argument}.`);
  }
  const specPath = optionValue(args, "--spec") ?? DEFAULT_SPEC;
  return {
    specPath,
    instanceIds: repeatedOptionValues(args, "--instance"),
    capacityOnly: args.includes("--capacity-only"),
    retryFailed: args.includes("--retry-failed"),
  };
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const values = repeatedOptionValues(args, flag);
  if (values.length > 1) throw new Error(`${flag} may be provided only once.`);
  return values[0];
}

function repeatedOptionValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

async function readManifest(spec: E2BCampaignSpec): Promise<InstanceManifest> {
  return JSON.parse(
    await readFile(resolve(REPO_ROOT, spec.manifestPath), "utf8"),
  ) as InstanceManifest;
}

async function gitOutput(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT });
  return stdout.trim();
}

function hostCampaignRoot(campaignId: string): string {
  return join(BENCH_ROOT, "runs", campaignId);
}

function remoteCampaignRoot(campaignId: string): string {
  return `${REMOTE_REPO_ROOT}/benchmarks/swebench/runs/${campaignId}`;
}

function pathSafeInstance(instanceId: string): string {
  if (!/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+$/.test(instanceId)) {
    throw new Error(`Instance id is not path-safe: ${instanceId}.`);
  }
  return instanceId;
}

function lineLogger(instanceId: string, stream: "out" | "err"): (chunk: string) => void {
  return (chunk) => {
    for (const line of chunk.replace(/\n$/, "").split("\n")) {
      if (line) console.log(`[${instanceId} ${stream}] ${line}`);
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
