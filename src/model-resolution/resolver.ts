import { findEnvKeys, getModel, type Model } from "@earendil-works/pi-ai";

import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type RoutingCatalogAdapter,
  type RoutingTable,
} from "../model-routing/table.js";
import {
  applyVercelGatewayModelOverrides,
  resolveDuetGatewayModel,
  resolveMissingModel,
} from "./duet-gateway.js";
import {
  canonicalizeModelName,
  canonicalizeProviderModelId,
  clampModelOutputTokens,
  DEFAULT_CLI_MEMORY_MODEL,
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
  /** explicit: CLI flag; inferred: provider env var present; default: active routing-table fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "AI_GATEWAY_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from a CLI env file rather than the shell. */
  fromDotenv?: boolean;
  /** True when the retained name is a virtual tier owned by model routing. */
  routed?: boolean;
}

export function resolveModelName(model: string): Model<any> {
  model = resolveModelReference(model);
  const separator = model.indexOf(":");
  if (separator === -1) {
    throw new Error("Models must use provider:modelId syntax");
  }
  const rawProvider = model.slice(0, separator);
  const rawModelId = model.slice(separator + 1);
  // The CLI supports only the router providers (duet-gateway, vercel-ai-gateway,
  // openrouter). Any other explicit pin — e.g. `anthropic:claude-opus-4-8` or
  // `openai:gpt-5.5` — is an unknown provider here: `resolveProviderShorthand`
  // returns undefined, the raw provider passes through, and `getModel` below
  // forwards it to pi-ai unchanged. That's incidental passthrough, not a
  // supported path: pi-ai resolves it if it ships that provider/id and the
  // caller supplies the credential, otherwise it resolves to an undefined
  // model. No catalog canonicalization applies to unknown providers.
  const provider = resolveProviderShorthand(rawProvider) ?? rawProvider;
  const modelId = isKnownProvider(provider)
    ? canonicalizeProviderModelId(provider, rawModelId)
    : rawModelId;
  if (provider === "duet-gateway") {
    // resolveDuetGatewayModel always returns a model: it falls back to a
    // synthesized pass-through spec for gateway ids pi-ai's catalog has not
    // shipped yet, so new gateway models work without a code change here.
    return clampModelOutputTokens(resolveDuetGatewayModel(modelId));
  }
  // getModel returns undefined for models the upstream catalog has not shipped
  // yet; fall back to a synthesized clone (e.g. Fable 5) before forwarding.
  // clampModelOutputTokens forwards a missing model untouched at runtime.
  const catalogModel =
    getModel(
      provider as Parameters<typeof getModel>[0],
      modelId as Parameters<typeof getModel>[1],
    ) ?? (resolveMissingModel(provider, modelId) as Model<any>);
  const resolved =
    provider === "vercel-ai-gateway" && catalogModel
      ? applyVercelGatewayModelOverrides(modelId, catalogModel)
      : catalogModel;
  return clampModelOutputTokens(resolved);
}

/** Shared concrete-catalog boundary used by every model-routing composition site. */
export const routingCatalogAdapter: RoutingCatalogAdapter = {
  isCatalogName: isKnownShorthand,
  modelAcceptsImages: (name: string) =>
    resolveModelName(
      isProviderPinnedModelName(name) ? name : `duet-gateway:${name}`,
    ).input.includes("image"),
};

/** Resolve a concrete catalog name to the provider-pinned reference used for model calls. */
export function pinnedModelReference(name: string): string {
  const model = resolveModelName(name);
  return `${model.provider}:${model.id}`;
}

function isKnownProvider(provider: string): provider is ProviderName {
  return PROVIDER_ORDER.some((entry) => entry.provider === provider);
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
 * "inferred from AI_GATEWAY_API_KEY in an env file" etc.
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string>,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): ModelResolution {
  return resolveCliModelWith(
    modelName,
    getDefaultModelCandidates(),
    dotenvKeys,
    routingTable.defaultTier,
    routingTable,
  );
}

function resolveCliModelWith(
  modelName: string | undefined,
  providerInference: ProviderModelCandidate[],
  dotenvKeys: Set<string>,
  defaultModel: string,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): ModelResolution {
  if (modelName) {
    if (isVirtualModel(modelName, routingTable)) {
      return { modelName, source: "explicit", routed: true };
    }
    if (isVirtualModel(modelName, BUILT_IN_ROUTING_TABLE)) {
      throw new Error(`Unknown virtual model tier "${modelName}" in the active routing table.`);
    }
    return {
      modelName: isProviderPinnedModelName(modelName)
        ? modelName
        : canonicalizeModelName(modelName),
      source: "explicit",
    };
  }
  if (isVirtualModel(defaultModel, routingTable)) {
    return { modelName: defaultModel, source: "default", routed: true };
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
  const routed = resolution.routed ? `${resolution.modelName} (routed) — ` : "";
  if (resolution.source === "explicit") return `${routed}explicit CLI flag`;
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "an env file" : "shell environment";
    return `${routed}inferred from ${resolution.envVar} in ${where}`;
  }
  return resolution.routed
    ? `${routed}routing-table default`
    : "built-in default (no provider env vars set)";
}
