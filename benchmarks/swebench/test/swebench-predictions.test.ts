import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RolloutAttempt } from "../src/artifacts.js";
import { buildPredictions, serializePredictions } from "../src/predictions.js";
import { parseScoringModelName, scoringModelName } from "../src/scoring-identity.js";
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

  testIfDocker(
    "gives repeated trials unique scorer identities without renaming trial one",
    async () => {
      root = await mkdtemp(join(tmpdir(), "duet-swebench-predictions-"));
      const trialOne = await attempt("org__repo-1", "glm-pure", 1, "completed", "trial one");
      const oldTrialTwo = await attempt(
        "org__repo-1",
        "glm-pure",
        1,
        "completed",
        "old trial two",
        2,
      );
      const trialTwo = await attempt("org__repo-1", "glm-pure", 2, "completed", "trial two", 2);
      const trialTwelve = await attempt(
        "org__repo-1",
        "glm-pure",
        1,
        "completed",
        "trial twelve",
        12,
      );

      expect(
        await buildPredictions([trialTwelve, oldTrialTwo, trialOne, trialTwo], "glm-pure"),
      ).toEqual([
        {
          instance_id: "org__repo-1",
          model_name_or_path: "duet-glm-pure",
          model_patch: "trial one",
        },
        {
          instance_id: "org__repo-1",
          model_name_or_path: "duet-glm-pure-trial-2",
          model_patch: "trial two",
        },
        {
          instance_id: "org__repo-1",
          model_name_or_path: "duet-glm-pure-trial-12",
          model_patch: "trial twelve",
        },
      ]);
    },
  );

  test("round-trips canonical scorer identities and rejects ambiguous spellings", () => {
    expect(scoringModelName("kimi-fable-advisor", 1)).toBe("duet-kimi-fable-advisor");
    expect(parseScoringModelName(scoringModelName("kimi-fable-advisor", 12))).toEqual({
      config: "kimi-fable-advisor",
      trial: 12,
    });
    expect(() => parseScoringModelName("duet-kimi-fable-advisor-trial-1")).toThrow(
      "Unknown campaign model_name_or_path",
    );
    expect(() => parseScoringModelName("duet-kimi-fable-advisor-trial-02")).toThrow(
      "Unknown campaign model_name_or_path",
    );
  });
});

async function attempt(
  instanceId: string,
  config: "glm-pure" | "kimi-pure",
  number: number,
  phase: "completed" | "failed",
  patch: string,
  trial = 1,
): Promise<RolloutAttempt> {
  const directory = join(root!, `${instanceId}-${config}-t${trial}-a${number}`);
  await mkdir(directory);
  await writeFile(join(directory, "patch.diff"), patch);
  return {
    directory,
    spec: {
      campaignId: "campaign",
      config,
      instanceId,
      trial,
      image: "image",
      duetSha256: "a",
      configSha256: "b",
      systemPromptSha256: "d",
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
