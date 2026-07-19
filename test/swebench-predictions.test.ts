import { afterEach, describe, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RolloutAttempt } from "../benchmarks/swebench/src/artifacts.js";
import { buildPredictions, serializePredictions } from "../benchmarks/swebench/src/predictions.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench predictions", () => {
  testIfDocker("emits the latest completed patch in official field names", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-predictions-"));
    const old = await attempt("org__repo-1", "glm-pure", 1, "completed", "old");
    const latest = await attempt("org__repo-1", "glm-pure", 2, "completed", "latest");
    const failed = await attempt("org__repo-2", "glm-pure", 1, "failed", "failed");
    const other = await attempt("org__repo-3", "kimi-pure", 1, "completed", "other");

    const predictions = await buildPredictions([old, failed, other, latest], "glm-pure");
    expect(predictions).toEqual([
      {
        instance_id: "org__repo-1",
        model_name_or_path: "duet-glm-pure",
        model_patch: "latest",
      },
    ]);
    expect(JSON.parse(serializePredictions(predictions).trim())).toEqual(predictions[0]);
  });
});

async function attempt(
  instanceId: string,
  config: "glm-pure" | "kimi-pure",
  number: number,
  phase: "completed" | "failed",
  patch: string,
): Promise<RolloutAttempt> {
  const directory = join(root!, `${instanceId}-${config}-${number}`);
  await mkdir(directory);
  await writeFile(join(directory, "patch.diff"), patch);
  return {
    directory,
    spec: {
      campaignId: "campaign",
      config,
      instanceId,
      trial: 1,
      image: "image",
      duetSha256: "a",
      configSha256: "b",
      promptSha256: "c",
      limits: { costUsd: 1, wallClockMs: 1, patchBytes: 1 },
    },
    status: {
      schemaVersion: 1,
      phase,
      specHash: "hash",
      attempt: number,
      startedAt: "now",
    },
  };
}
