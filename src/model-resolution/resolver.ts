import type { Api, Model } from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type RoutingCatalogAdapter,
  type RoutingTable,
} from "../model-routing/table.js";
import { gatewayRoute, resolveGatewayModel } from "./duet-gateway.js";
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
  type RouterProviderName,
  resolveProviderShorthand,
} from "./catalog.js";
import { connectedTransportSnapshot } from "../cli/shared.js";
import { chooseTransport } from "../connected-providers/transport-preference.js";
import {
  applyConnectedModelHook,
  connectedProviderApiKey,
  refreshConnectedTokenInBackground,
} from "../connected-providers/tokens.js";
import { isConnectedProviderId, type ConnectedProviderId } from "../connected-providers/store.js";

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
  // openrouter). Any other explicit pin — e.g. `anthropic:claude-opus-5` or
  // `openai:gpt-5.6-sol` — is an unknown provider here: `resolveProviderShorthand`
  // returns undefined, the raw provider passes through, and `getModel` below
  // forwards it to pi-ai unchanged. That's incidental passthrough, not a
  // supported path: pi-ai resolves it if it ships that provider/id and the
  // caller supplies the credential, otherwise it resolves to an undefined
  // model. No catalog canonicalization applies to unknown providers.
  const provider = resolveProviderShorthand(rawProvider) ?? rawProvider;
  const modelId = isKnownProvider(provider)
    ? canonicalizeProviderModelId(provider, rawModelId)
    : rawModelId;
  // A gateway route resolves through its own module: it picks a transport per
  // model rather than inheriting the catalog's blanket anthropic-messages
  // declaration, and it always returns a model, falling back to a synthesized
  // pass-through for an id the catalog has not shipped.
  const route = gatewayRoute(provider);
  if (route) return clampModelOutputTokens(resolveGatewayModel(route, modelId));
  // The catalog answers for every other provider. clampModelOutputTokens
  // forwards a missing model untouched at runtime.
  return clampModelOutputTokens(builtinModel(provider, modelId) as Model<any>);
}

/** Resolve an auxiliary actor through configured metered router order only. */
export function resolveMeteredModelName(modelName: string): Model<any> {
  return resolveModelName(resolveRouterModelReference(modelName));
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

function isKnownProvider(provider: string): provider is RouterProviderName {
  return PROVIDER_ORDER.some((entry) => entry.provider === provider);
}

/** Router providers whose credential env var is configured in this process. */
export function configuredRouterProviders(): RouterProviderName[] {
  return PROVIDER_ORDER.filter((entry) => lookupProviderEnvVar(entry) !== undefined).map(
    (entry) => entry.provider,
  );
}

function lookupProviderEnvVar(entry: {
  provider: RouterProviderName;
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

interface ConnectedModelResolutionDependencies {
  snapshot(): ReturnType<typeof connectedTransportSnapshot>;
  apiKey(provider: ConnectedProviderId): string | undefined;
  applyHook<T extends { id: string }>(provider: ConnectedProviderId, model: T): T | undefined;
  refresh(provider: ConnectedProviderId): void;
}

const connectedModelResolutionDependencies: ConnectedModelResolutionDependencies = {
  snapshot: connectedTransportSnapshot,
  apiKey: connectedProviderApiKey,
  applyHook: applyConnectedModelHook,
  refresh: refreshConnectedTokenInBackground,
};

/** Resolve an unpinned catalog name through connected plans, then router order. */
export function resolveModelReference(
  modelName: string,
  deps: ConnectedModelResolutionDependencies = connectedModelResolutionDependencies,
): string {
  if (isProviderPinnedModelName(modelName)) return modelName;

  const transport = chooseTransport(modelName, deps.snapshot());
  if (transport.planCovered && isConnectedProviderId(transport.transport)) {
    const provider = transport.transport;
    if (deps.apiKey(provider)) {
      // The account hook can filter models the plan cannot serve (Copilot
      // availableModelIds); a filtered model falls through to router order.
      const spec = builtinModel(provider, transport.modelId);
      if (!spec || deps.applyHook(provider, spec)) {
        return `${provider}:${transport.modelId}`;
      }
    } else {
      // Resolution must remain synchronous. A cache miss cannot wait here, so
      // this call keeps the existing router path while a later resolution can
      // use the coalesced refresh started in the background.
      deps.refresh(provider);
    }
  }

  return resolveRouterModelReference(modelName);
}

function resolveRouterModelReference(modelName: string): string {
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

/** Catalog read for ids this module only knows as strings. */
function builtinModel(provider: string, modelId: string): Model<Api> | undefined {
  return getBuiltinModel(
    provider as Parameters<typeof getBuiltinModel>[0],
    modelId as Parameters<typeof getBuiltinModel>[1],
  ) as Model<Api> | undefined;
}
