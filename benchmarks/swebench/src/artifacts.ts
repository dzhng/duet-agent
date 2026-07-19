import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TurnEvent } from "../../../src/types/protocol.js";
import type { CampaignConfigName } from "./config-override.js";
import type { RolloutTelemetry } from "./telemetry.js";

/** Logical rollout identity shared by immutable retry attempts. */
export interface RolloutIdentity {
  campaignId: string;
  config: CampaignConfigName;
  instanceId: string;
  trial: number;
}

/** Frozen inputs whose hash decides whether an artifact can be resumed. */
export interface RolloutArtifactSpec extends RolloutIdentity {
  image: string;
  duetSha256: string;
  configSha256: string;
  promptSha256: string;
  limits: {
    costUsd: number;
    wallClockMs: number;
    interruptGraceMs?: number;
    patchBytes: number;
  };
}

export type RolloutFailureKind = "agent" | "infra" | "patch";

/** Atomic completion marker; its absence or `running` phase means crashed work. */
export interface RolloutStatus {
  schemaVersion: 1;
  phase: "running" | "completed" | "failed";
  specHash: string;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  failureKind?: RolloutFailureKind;
  message?: string;
  terminalType?: string;
  costUsd?: number;
}

/** One immutable filesystem attempt and its current marker. */
export interface RolloutAttempt {
  directory: string;
  spec: RolloutArtifactSpec;
  status: RolloutStatus;
}

/** Stable SHA-256 for a JSON-compatible value with caller-controlled key order. */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** SHA-256 of exact text bytes such as a prompt or committed render. */
export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Allocate a new attempt without mutating any earlier failed or crashed attempt. */
export async function beginRolloutAttempt(
  runsRoot: string,
  spec: RolloutArtifactSpec,
): Promise<RolloutAttempt> {
  validateIdentity(spec);
  const configRoot = join(runsRoot, spec.campaignId, spec.config);
  await mkdir(configRoot, { recursive: true });
  const prefix = `${spec.instanceId}-t${spec.trial}`;
  const names = await readdir(configRoot);
  const attempt =
    1 +
    names.reduce((highest, name) => {
      if (name === prefix) return Math.max(highest, 1);
      const match = name.match(new RegExp(`^${escapeRegExp(prefix)}-a(\\d+)$`));
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
  const directory = join(configRoot, attempt === 1 ? prefix : `${prefix}-a${attempt}`);
  const status: RolloutStatus = {
    schemaVersion: 1,
    phase: "running",
    specHash: hashJson(spec),
    attempt,
    startedAt: new Date().toISOString(),
  };
  await mkdir(directory);
  await atomicWriteJson(join(directory, "spec.json"), spec);
  await atomicWriteJson(join(directory, "status.json"), status);
  return { directory, spec, status };
}

/** Finalize a successful attempt; `status.json` is renamed last. */
export async function completeRolloutAttempt(
  attempt: RolloutAttempt,
  values: {
    events: readonly TurnEvent[];
    patch: string;
    patchPaths: readonly string[];
    telemetry: RolloutTelemetry;
    terminalType: string;
  },
): Promise<RolloutStatus> {
  await writeAttemptEvidence(attempt.directory, values.events, values.telemetry);
  await Promise.all([
    atomicWrite(join(attempt.directory, "patch.diff"), values.patch),
    atomicWriteJson(join(attempt.directory, "patch-paths.json"), values.patchPaths),
  ]);
  const status: RolloutStatus = {
    ...attempt.status,
    phase: "completed",
    finishedAt: new Date().toISOString(),
    terminalType: values.terminalType,
    costUsd: values.telemetry.costUsdTotal,
  };
  await atomicWriteJson(join(attempt.directory, "status.json"), status);
  return status;
}

/** Finalize a failed attempt while preserving all evidence available at failure time. */
export async function failRolloutAttempt(
  attempt: RolloutAttempt,
  values: {
    kind: RolloutFailureKind;
    message: string;
    events?: readonly TurnEvent[];
    telemetry?: RolloutTelemetry;
    patch?: string;
    patchPaths?: readonly string[];
    terminalType?: string;
  },
): Promise<RolloutStatus> {
  if (values.events && values.telemetry) {
    await writeAttemptEvidence(attempt.directory, values.events, values.telemetry);
  }
  if (values.patch !== undefined)
    await atomicWrite(join(attempt.directory, "patch.diff"), values.patch);
  if (values.patchPaths !== undefined) {
    await atomicWriteJson(join(attempt.directory, "patch-paths.json"), values.patchPaths);
  }
  const status: RolloutStatus = {
    ...attempt.status,
    phase: "failed",
    finishedAt: new Date().toISOString(),
    failureKind: values.kind,
    message: values.message,
    ...(values.terminalType ? { terminalType: values.terminalType } : {}),
    ...(values.telemetry ? { costUsd: values.telemetry.costUsdTotal } : {}),
  };
  await atomicWriteJson(join(attempt.directory, "status.json"), status);
  return status;
}

/** Read every attempt marker for status, budget, and resume planning. */
export async function loadRolloutAttempts(
  runsRoot: string,
  campaignId: string,
): Promise<RolloutAttempt[]> {
  const campaignRoot = join(runsRoot, campaignId);
  const attempts: RolloutAttempt[] = [];
  for (const configName of await safeReaddir(campaignRoot)) {
    const configRoot = join(campaignRoot, configName);
    for (const attemptName of await safeReaddir(configRoot)) {
      const directory = join(configRoot, attemptName);
      try {
        const [spec, status] = await Promise.all([
          readJson<RolloutArtifactSpec>(join(directory, "spec.json")),
          readJson<RolloutStatus>(join(directory, "status.json")),
        ]);
        attempts.push({ directory, spec, status });
      } catch {
        // A process can die between directory creation and its first atomic
        // marker. Such a directory is incomplete evidence, never completed work.
      }
    }
  }
  return attempts;
}

async function writeAttemptEvidence(
  directory: string,
  events: readonly TurnEvent[],
  telemetry: RolloutTelemetry,
): Promise<void> {
  const ndjson = events.map((event) => JSON.stringify(event)).join("\n");
  await Promise.all([
    atomicWrite(join(directory, "events.ndjson"), ndjson ? `${ndjson}\n` : ""),
    atomicWriteJson(join(directory, "telemetry.json"), telemetry),
  ]);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

function validateIdentity(identity: RolloutIdentity): void {
  for (const [name, value] of [
    ["campaignId", identity.campaignId],
    ["config", identity.config],
    ["instanceId", identity.instanceId],
  ] as const) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) {
      throw new Error(`${name} is not a safe artifact path component.`);
    }
  }
  if (!Number.isSafeInteger(identity.trial) || identity.trial < 1) {
    throw new Error("trial must be a positive integer.");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
