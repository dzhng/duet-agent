import { findEnvKeys, getModel, type Model } from "@earendil-works/pi-ai";

import { resolveDuetGatewayModel } from "./duet-gateway.js";
import {
  canonicalizeModelName,
  DEFAULT_CLI_MEMORY_MODEL,
  DEFAULT_CLI_MODEL,
  getModelCandidates,
  getProviderDefaultModel,
  getProviderMemoryModel,
  isKnownShorthand,
  isProviderPinnedModelName,
  PROVIDER_ORDER,
  type ProviderModelCandidate,
  type ProviderName,
  resolveProviderShorthand,
} from "./catalog.js";

export { DEFAULT_CLI_MEMORY_MODEL, DEFAULT_CLI_MODEL } from "./catalog.js";

/**
 * Resolves which provider:modelId the CLI talks to, plus the provenance for
 * that decision (explicit flag, inferred from env, or built-in fallback). The
 * shape lives in its own module so cli.ts stays focused on argv parsing and
 * the I/O harness — provider list changes don't touch the CLI surface.
 */

export interface ModelResolution {
  /** Model name retained for config, display, and later runtime resolution. */
  modelName: string;
  /** explicit: CLI flag; inferred: provider env var present; default: built-in fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "ANTHROPIC_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from a CLI env file rather than the shell. */
  fromDotenv?: boolean;
}

export function resolveModelName(model: string): Model<any> {
  model = resolveModelReference(model);
  const separator = model.indexOf(":");
  if (separator === -1) {
    throw new Error("Models must use provider:modelId syntax");
  }
  const rawProvider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const provider = resolveProviderShorthand(rawProvider) ?? rawProvider;
  if (provider === "duet-gateway") {
    const resolved = resolveDuetGatewayModel(modelId);
    if (!resolved) {
      throw new Error(`Unknown duet-gateway model: ${modelId}`);
    }
    return resolved;
  }
  return getModel(
    provider as Parameters<typeof getModel>[0],
    modelId as Parameters<typeof getModel>[1],
  );
}

function lookupProviderEnvVar(entry: {
  provider: ProviderName;
  customEnvVar?: () => string | null;
}): string | undefined {
  if (entry.customEnvVar) {
    return entry.customEnvVar() ?? undefined;
  }
  const envVars = findEnvKeys(entry.provider);
  return envVars && envVars.length > 0 ? envVars[0] : undefined;
}

/**
 * Same selection logic as resolveCliModel, but picks each provider's cheaper
 * observational-memory model.
 */
export function resolveCliMemoryModel(
  memoryModelName: string | undefined,
  dotenvKeys: Set<string>,
): ModelResolution {
  return resolveCliModelWith(
    memoryModelName,
    getMemoryModelCandidates(),
    dotenvKeys,
    DEFAULT_CLI_MEMORY_MODEL,
  );
}

/**
 * Resolve the user-visible model and report provenance so callers can show
 * "inferred from ANTHROPIC_API_KEY in an env file" etc.
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string>,
): ModelResolution {
  return resolveCliModelWith(modelName, getDefaultModelCandidates(), dotenvKeys, DEFAULT_CLI_MODEL);
}

function resolveCliModelWith(
  modelName: string | undefined,
  providerInference: ProviderModelCandidate[],
  dotenvKeys: Set<string>,
  defaultModel: string,
): ModelResolution {
  if (modelName) {
    return {
      modelName: isProviderPinnedModelName(modelName)
        ? modelName
        : canonicalizeModelName(modelName),
      source: "explicit",
    };
  }
  const inferred = findInferredProviderEntry(providerInference);
  if (inferred) {
    return {
      modelName: inferred.entry.modelName,
      source: "inferred",
      envVar: inferred.envVar,
      fromDotenv: dotenvKeys.has(inferred.envVar),
    };
  }
  return { modelName: defaultModel, source: "default" };
}

function findInferredProviderEntry(
  providerInference: readonly ProviderModelCandidate[],
): { entry: ProviderModelCandidate; envVar: string } | undefined {
  for (const entry of providerInference) {
    const provider = PROVIDER_ORDER.find((candidate) => candidate.provider === entry.provider);
    if (!provider) continue;

    const envVar = lookupProviderEnvVar(provider);
    if (envVar) return { entry, envVar };
  }
  return undefined;
}

function getDefaultModelCandidates(): ProviderModelCandidate[] {
  return PROVIDER_ORDER.map(({ provider }) => ({
    provider,
    modelName: getProviderDefaultModel(provider),
  }));
}

function getMemoryModelCandidates(): ProviderModelCandidate[] {
  return PROVIDER_ORDER.map(({ provider }) => ({
    provider,
    modelName: getProviderMemoryModel(provider),
  }));
}

function resolveModelReference(modelName: string): string {
  if (isProviderPinnedModelName(modelName)) return modelName;

  const inferred = findInferredProviderEntry(getModelCandidates(modelName));
  if (inferred) return inferred.entry.modelName;

  if (isKnownShorthand(modelName)) {
    throw new Error(`Model shorthand requires credentials for a supported provider: ${modelName}`);
  }

  throw new Error(`Unknown model shorthand: ${modelName}`);
}

export function describeModelResolution(resolution: ModelResolution): string {
  if (resolution.source === "explicit") return "explicit CLI flag";
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "an env file" : "shell environment";
    return `inferred from ${resolution.envVar} in ${where}`;
  }
  return "built-in default (no provider env vars set)";
}
