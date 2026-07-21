import { readFile } from "node:fs/promises";

import type { TurnEvent } from "../../../src/types/protocol.js";
import {
  beginRolloutAttempt,
  completeRolloutAttempt,
  failRolloutAttempt,
  hashText,
  type RolloutArtifactSpec,
  type RolloutAttempt,
  type RolloutStatus,
} from "./artifacts.js";
import type { CampaignConfigName } from "./config-override.js";
import type { CommandResult } from "./container.js";
import {
  runDuetTurn,
  type ExecTransport,
  type RolloutLimits,
  type RolloutOutcome,
} from "./duet-client.js";
import type { DuetArtifact } from "./packaging.js";
import { capturePatchBaseline, extractPatch } from "./patch.js";
import { lintPatch } from "./patch-policy.js";
import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "./prompt.js";
import type { DatasetRow, ManifestEntry } from "./manifest.js";
import { deriveTelemetry, type RolloutTelemetry } from "./telemetry.js";

/** Runtime inputs for one immutable benchmark work unit. */
export interface RunRolloutSpec {
  campaignId: string;
  config: CampaignConfigName;
  entry: ManifestEntry;
  datasetRow: DatasetRow;
  trial: number;
  image: string;
  configPath: string;
  configSha256: string;
  limits: RolloutLimits & { patchBytes: number };
}

/** Injected boundaries shared by live and scripted rollout tests. */
export interface RunRolloutDependencies {
  runsRoot: string;
  artifact: DuetArtifact;
  providerEnv: Record<string, string>;
  containerFactory(name: string, image: string): RolloutContainer;
}

/** Container surface used by a rollout; production supplies the Docker-backed implementation. */
export interface RolloutContainer {
  start(): Promise<void>;
  cpIn(localPath: string, containerPath: string): Promise<void>;
  exec(
    argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ): Promise<CommandResult>;
  execStream(
    argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): ExecTransport;
  stop(): Promise<void>;
}

/** Durable result returned after the container has been torn down. */
export interface RunRolloutResult {
  attempt: RolloutAttempt;
  status: RolloutStatus;
}

/** Run duet inside one official image and persist all available evidence. */
export async function runRollout(
  dependencies: RunRolloutDependencies,
  spec: RunRolloutSpec,
): Promise<RunRolloutResult> {
  if (spec.datasetRow.instanceId !== spec.entry.instanceId) {
    throw new Error(`Dataset row does not match manifest entry ${spec.entry.instanceId}.`);
  }
  const prompt = buildRolloutPrompt({
    problemStatement: spec.datasetRow.problemStatement,
  });
  const artifactSpec: RolloutArtifactSpec = {
    campaignId: spec.campaignId,
    config: spec.config,
    instanceId: spec.entry.instanceId,
    trial: spec.trial,
    image: spec.image,
    duetSha256: dependencies.artifact.sha256,
    configSha256: spec.configSha256,
    systemPromptSha256: hashText(SWEBENCH_SYSTEM_PROMPT),
    promptSha256: hashText(prompt),
    limits: {
      costUsd: spec.limits.costUsd,
      wallClockMs: spec.limits.wallClockMs,
      ...(spec.limits.interruptGraceMs === undefined
        ? {}
        : { interruptGraceMs: spec.limits.interruptGraceMs }),
      patchBytes: spec.limits.patchBytes,
    },
  };
  const attempt = await beginRolloutAttempt(dependencies.runsRoot, artifactSpec);
  const containerName = benchmarkContainerName(spec, attempt.status.attempt);
  const container = dependencies.containerFactory(containerName, spec.image);
  let events: TurnEvent[] = [];
  let telemetry: RolloutTelemetry | undefined;
  let outcome: RolloutOutcome | undefined;
  let patch: string | undefined;
  let patchPaths: string[] | undefined;
  let result: RunRolloutResult | undefined;
  let pendingError: unknown;

  try {
    await container.start();
    await container.exec(["mkdir", "-p", "/opt/duet/home/.duet"]);
    await Promise.all([
      container.cpIn(dependencies.artifact.localPath, dependencies.artifact.installPath),
      ...dependencies.artifact.runtimeAssets.map((asset) =>
        container.cpIn(asset.localPath, asset.installPath),
      ),
      container.cpIn(spec.configPath, "/opt/duet/home/.duet/models.json"),
    ]);
    const chmod = await container.exec(["chmod", "0755", dependencies.artifact.installPath]);
    if (chmod.exitCode !== 0) throw new Error(`Could not make duet executable: ${chmod.stderr}`);

    const baseline = await capturePatchBaseline(container);
    // A fresh HOME isolates every rollout, while a stable session id lets
    // normal memory range markers prevent repeated observation of one transcript.
    const transport = container.execStream(
      [
        dependencies.artifact.installPath,
        "--rpc",
        "--model",
        "swebench",
        "--session",
        "swebench",
        "--workdir",
        "/testbed",
        "--system-prompt",
        SWEBENCH_SYSTEM_PROMPT,
      ],
      {
        cwd: "/testbed",
        env: {
          ...dependencies.providerEnv,
          HOME: "/opt/duet/home",
          CI: "1",
          PAGER: "cat",
          GIT_PAGER: "cat",
          BAT_PAGER: "cat",
          TERM: "dumb",
        },
      },
    );
    outcome = await runDuetTurn(
      transport,
      {
        limits: {
          costUsd: spec.limits.costUsd,
          wallClockMs: spec.limits.wallClockMs,
          ...(spec.limits.interruptGraceMs === undefined
            ? {}
            : { interruptGraceMs: spec.limits.interruptGraceMs }),
        },
      },
      prompt,
    );
    events = outcome.events;
    telemetry = deriveTelemetry(events);
    if (outcome.killedReason === "process_exit") {
      throw new Error("Duet RPC process exited before emitting a terminal event.");
    }
    const extracted = await extractPatch(container, baseline, spec.limits.patchBytes);
    patch = extracted.patch;
    patchPaths = extracted.paths;
    const patchLint = lintPatch(patch, patchPaths, spec.limits.patchBytes);
    if (patchLint.admissionViolations.length > 0) {
      throw new Error(`Patch policy violation: ${patchLint.admissionViolations.join("; ")}`);
    }
    const terminalType = terminalName(outcome);
    const status = await completeRolloutAttempt(attempt, {
      events,
      patch,
      patchPaths,
      telemetry,
      terminalType,
    });
    result = { attempt, status };
  } catch (error) {
    telemetry ??= events.length > 0 ? deriveTelemetry(events) : undefined;
    try {
      const status = await failRolloutAttempt(attempt, {
        kind: classifyFailure(error, outcome),
        message: errorMessage(error),
        ...(events.length > 0 && telemetry ? { events, telemetry } : {}),
        ...(patch === undefined ? {} : { patch }),
        ...(patchPaths === undefined ? {} : { patchPaths }),
        ...(outcome ? { terminalType: terminalName(outcome) } : {}),
      });
      result = { attempt, status };
    } catch (finalizationError) {
      pendingError = finalizationError;
    }
  }

  try {
    await container.stop();
  } catch (stopError) {
    if (pendingError)
      throw new AggregateError([pendingError, stopError], "Rollout and teardown failed.");
    const status = await failRolloutAttempt(attempt, {
      kind: "infra",
      message: `Container teardown failed: ${errorMessage(stopError)}`,
      ...(events.length > 0 && telemetry ? { events, telemetry } : {}),
      ...(patch === undefined ? {} : { patch }),
      ...(patchPaths === undefined ? {} : { patchPaths }),
      ...(outcome ? { terminalType: terminalName(outcome) } : {}),
    });
    result = { attempt, status };
  }
  if (pendingError) throw pendingError;
  if (!result) throw new Error("Rollout ended without a durable status.");
  return result;
}

/** SHA-256 of the exact routing render installed for a rollout. */
export async function hashConfigFile(path: string): Promise<string> {
  return hashText(await readFile(path, "utf8"));
}

function benchmarkContainerName(spec: RunRolloutSpec, attempt: number): string {
  const suffix = `${spec.config}-${spec.entry.instanceId}-t${spec.trial}-a${attempt}`
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(-100);
  return `duet-swebench-${suffix}`;
}

function terminalName(outcome: RolloutOutcome): string {
  return outcome.terminal === "killed" ? "killed" : outcome.terminal.type;
}

function classifyFailure(error: unknown, outcome: RolloutOutcome | undefined) {
  if (!outcome || outcome.killedReason === "process_exit") return "infra" as const;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("patch") || message.includes("Patch")) return "patch" as const;
  return "agent" as const;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
