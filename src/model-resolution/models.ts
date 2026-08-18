import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { connectedProviders } from "../connected-providers/registry.js";
import { GATEWAY_ROUTES, gatewayProvider } from "./duet-gateway.js";

/**
 * The model registry every dispatch goes through: pi-ai's built-in providers,
 * the gateway routes, and connected providers with Duet's own credential path
 * declared.
 *
 * The agent loop is handed a `StreamFn` rather than resolving a transport
 * itself, so this is the one place that decides who can serve a model.
 *
 * Rebuilt per call rather than cached. The expensive part — rebasing two
 * hundred catalog entries per route — is memoized behind `gatewayProvider`,
 * which leaves assembly at ~0.05ms; a cache here would save that and buy a
 * staleness bug, because its key would have to track every origin and
 * credential the registry closes over.
 */
export function duetModels(): MutableModels {
  const models = builtinModels();
  for (const route of GATEWAY_ROUTES) models.setProvider(gatewayProvider(route));
  for (const { id } of connectedProviders()) {
    const provider = models.getProvider(id);
    if (provider) models.setProvider(withDuetManagedAuth(provider));
  }
  return models;
}

/**
 * A connected provider, with the fact that Duet holds its credential declared.
 *
 * Duet stores and refreshes ChatGPT and Copilot tokens itself, in its own
 * store with its own eligibility rules, and hands the resolved token to each
 * request as `apiKey`. pi-ai only honors that override for a provider that
 * declares api-key auth, and `openai-codex` declares OAuth alone — so without
 * this every ChatGPT-connected turn is refused with "Provider is not
 * configured" before a request is ever built. A provider that already declares
 * api-key auth (Copilot) keeps its own, which derives a per-account baseUrl.
 */
function withDuetManagedAuth(provider: Provider): Provider {
  if (provider.auth.apiKey) return provider;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: `${provider.name} (managed by Duet)`,
        async resolve({ credential }) {
          const key = credential?.key;
          return key ? { auth: { apiKey: key }, source: "Duet connected account" } : undefined;
        },
      },
    },
  };
}

/**
 * Dispatch for the agent loop. The model object carries its own provider,
 * baseUrl and tier headers by the time it arrives here, so this only has to
 * pick the transport the model declares.
 */
export const duetStreamFn: StreamFn = (model, context, options) =>
  duetModels().streamSimple(model, context, options);
