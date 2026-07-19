import { readFile } from "node:fs/promises";

import type { CampaignConfigName } from "./config-override.js";
import type { RolloutAttempt } from "./artifacts.js";

/** Exact row accepted by the official SWE-bench predictions loader. */
export interface SwebenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

/** Convert completed immutable attempts into one prediction per logical rollout. */
export async function buildPredictions(
  attempts: readonly RolloutAttempt[],
  config: CampaignConfigName,
): Promise<SwebenchPrediction[]> {
  const latestByRollout = new Map<string, RolloutAttempt>();
  for (const attempt of attempts) {
    if (attempt.spec.config !== config || attempt.status.phase !== "completed") continue;
    const key = `${attempt.spec.instanceId}:t${attempt.spec.trial}`;
    const existing = latestByRollout.get(key);
    if (!existing || existing.status.attempt < attempt.status.attempt) {
      latestByRollout.set(key, attempt);
    }
  }
  const predictions = await Promise.all(
    [...latestByRollout.values()].map(async (attempt) => ({
      instance_id: attempt.spec.instanceId,
      model_name_or_path: `duet-${config}`,
      model_patch: await readFile(`${attempt.directory}/patch.diff`, "utf8"),
    })),
  );
  return predictions.sort((left, right) => left.instance_id.localeCompare(right.instance_id));
}

export function serializePredictions(predictions: readonly SwebenchPrediction[]): string {
  return (
    predictions.map((prediction) => JSON.stringify(prediction)).join("\n") +
    (predictions.length > 0 ? "\n" : "")
  );
}
