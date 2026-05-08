import { findEnvKeys, getModel, type Model } from "@earendil-works/pi-ai";

import {
  DUET_GATEWAY_API_KEY_ENV,
  isDuetGatewayModelName,
  resolveDuetGatewayModel,
} from "./duet-gateway.js";

/**
 * Resolves which provider:modelId the CLI talks to, plus the provenance for
 * that decision (explicit flag, inferred from env, or built-in fallback). The
 * shape lives in its own module so cli.ts stays focused on argv parsing and
 * the I/O harness — provider list changes don't touch the CLI surface.
 */

export interface ModelResolution {
  modelName: string;
  /** explicit: CLI flag; inferred: provider env var present; default: built-in fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "ANTHROPIC_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from a CLI env file rather than the shell. */
  fromDotenv?: boolean;
}

interface ProviderInferenceEntry {
  provider: string;
  model: string;
  customEnvVar?: () => string | null;
}

/**
 * Provider inference order. Entries are tried top-to-bottom; the first one
 * with a present env var wins. `customEnvVar` covers providers pi-ai's
 * `findEnvKeys` doesn't know about (currently only `duet-gateway`).
 *
 * `duet-gateway` sits before `vercel-ai-gateway` because the CLI startup shim
 * copies `DUET_API_KEY` into `AI_GATEWAY_API_KEY`, which would otherwise route
 * through Vercel's gateway directly when the user only set `DUET_API_KEY`.
 */
const MODEL_PROVIDER_INFERENCE: ProviderInferenceEntry[] = [
  {
    provider: "anthropic",
    model: "anthropic:claude-opus-4-7",
  },
  {
    provider: "duet-gateway",
    model: "duet-gateway:anthropic/claude-opus-4.7",
    customEnvVar: () => (process.env[DUET_GATEWAY_API_KEY_ENV] ? DUET_GATEWAY_API_KEY_ENV : null),
  },
  {
    provider: "vercel-ai-gateway",
    model: "vercel-ai-gateway:anthropic/claude-opus-4.7",
  },
  {
    provider: "openrouter",
    model: "openrouter:anthropic/claude-opus-4.7",
  },
  {
    provider: "openai",
    model: "openai:gpt-5.5",
  },
];

const MEMORY_MODEL_PROVIDER_INFERENCE: ProviderInferenceEntry[] = [
  {
    provider: "anthropic",
    model: "anthropic:claude-haiku-4-5",
  },
  {
    provider: "duet-gateway",
    model: "duet-gateway:anthropic/claude-haiku-4.5",
    customEnvVar: () => (process.env[DUET_GATEWAY_API_KEY_ENV] ? DUET_GATEWAY_API_KEY_ENV : null),
  },
  {
    provider: "vercel-ai-gateway",
    model: "vercel-ai-gateway:anthropic/claude-haiku-4.5",
  },
  {
    provider: "openrouter",
    model: "openrouter:anthropic/claude-haiku-4.5",
  },
  {
    provider: "openai",
    model: "openai:gpt-5.4-mini",
  },
];

export const DEFAULT_CLI_MODEL = MODEL_PROVIDER_INFERENCE[0].model;
export const DEFAULT_CLI_MEMORY_MODEL = MEMORY_MODEL_PROVIDER_INFERENCE[0].model;

export function resolveModelName(model: string): Model<any> {
  const separator = model.indexOf(":");
  if (separator === -1) {
    throw new Error("Models must use provider:modelId syntax");
  }
  if (isDuetGatewayModelName(model)) {
    const modelId = model.slice(separator + 1);
    const resolved = resolveDuetGatewayModel(modelId);
    if (!resolved) {
      throw new Error(`Unknown duet-gateway model: ${modelId}`);
    }
    return resolved;
  }
  const provider = model.slice(0, separator) as Parameters<typeof getModel>[0];
  const modelId = model.slice(separator + 1) as Parameters<typeof getModel>[1];
  return getModel(provider, modelId);
}

function lookupProviderEnvVar(entry: ProviderInferenceEntry): string | undefined {
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
  return resolveCliModelWith(memoryModelName, MEMORY_MODEL_PROVIDER_INFERENCE, dotenvKeys);
}

/**
 * Resolve the user-visible model and report provenance so callers can show
 * "inferred from ANTHROPIC_API_KEY in an env file" etc.
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string>,
): ModelResolution {
  return resolveCliModelWith(modelName, MODEL_PROVIDER_INFERENCE, dotenvKeys);
}

function resolveCliModelWith(
  modelName: string | undefined,
  providerInference: ProviderInferenceEntry[],
  dotenvKeys: Set<string>,
): ModelResolution {
  if (modelName) return { modelName, source: "explicit" };
  const inferred = findInferredProviderEntry(providerInference);
  if (inferred) {
    return {
      modelName: inferred.entry.model,
      source: "inferred",
      envVar: inferred.envVar,
      fromDotenv: dotenvKeys.has(inferred.envVar),
    };
  }
  return { modelName: providerInference[0].model, source: "default" };
}

function findInferredProviderEntry(
  providerInference: ProviderInferenceEntry[],
): { entry: ProviderInferenceEntry; envVar: string } | undefined {
  for (const entry of providerInference) {
    const envVar = lookupProviderEnvVar(entry);
    if (envVar) return { entry, envVar };
  }
  return undefined;
}

export function describeModelResolution(resolution: ModelResolution): string {
  if (resolution.source === "explicit") return "explicit CLI flag";
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "an env file" : "shell environment";
    return `inferred from ${resolution.envVar} in ${where}`;
  }
  return "built-in default (no provider env vars set)";
}
