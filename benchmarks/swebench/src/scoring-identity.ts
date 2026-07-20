import { CAMPAIGN_CONFIG_NAMES, type CampaignConfigName } from "./config-override.js";

/** Campaign arm and repetition encoded in the official scorer's model identity. */
export interface ScoringIdentity {
  /** Benchmark configuration whose patch the official scorer evaluated. */
  config: CampaignConfigName;
  /** One-based campaign repetition for the instance and configuration. */
  trial: number;
}

/**
 * Give each logical rollout its own official scorer identity.
 *
 * Trial one keeps the original campaign name so existing single-trial campaign
 * artifacts remain directly comparable. Repeated trials receive an explicit
 * suffix because SWE-bench keys its output and cache by model plus instance.
 */
export function scoringModelName(config: CampaignConfigName, trial: number): string {
  if (!Number.isSafeInteger(trial) || trial < 1) {
    throw new Error("Scoring trial must be a positive integer.");
  }
  return `duet-${config}${trial === 1 ? "" : `-trial-${trial}`}`;
}

/** Recover the campaign arm and trial from an official scorer model identity. */
export function parseScoringModelName(model: string): ScoringIdentity {
  const trialOneConfig = CAMPAIGN_CONFIG_NAMES.find(
    (config) => model === scoringModelName(config, 1),
  );
  if (trialOneConfig) return { config: trialOneConfig, trial: 1 };
  for (const config of CAMPAIGN_CONFIG_NAMES) {
    const prefix = `${scoringModelName(config, 1)}-trial-`;
    if (!model.startsWith(prefix)) continue;
    const suffix = model.slice(prefix.length);
    const trial = Number(suffix);
    if (Number.isSafeInteger(trial) && trial > 1 && String(trial) === suffix) {
      return { config, trial };
    }
  }
  throw new Error(`Unknown campaign model_name_or_path: ${model}.`);
}
