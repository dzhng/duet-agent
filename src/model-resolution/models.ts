import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { connectedProviders } from "../connected-providers/registry.js";
import {
  duetGatewayProvider,
  getDuetGatewayBaseUrl,
  vercelGatewayProvider,
} from "./duet-gateway.js";

/**
 * The model registry every dispatch goes through: pi-ai's built-in providers
 * plus Duet's own gateway provider.
 *
 * pi-agent-core no longer resolves a transport itself — a caller hands it a
 * `StreamFn` — so this is the one place that decides who can serve a model.
 * Registering `duet-gateway` here is what lets the gateway declare its own
 * models and its own auth instead of impersonating another provider's.
 *
 * Rebuilt when the gateway origin changes: `DUET_GATEWAY_BASE_URL` is read from
 * the environment, and tests point it at a local server between cases.
 */
let cached: { baseUrl: string; models: MutableModels } | undefined;

export function duetModels(): MutableModels {
  const baseUrl = getDuetGatewayBaseUrl();
  if (cached?.baseUrl !== baseUrl) {
    const models = builtinModels();
    models.setProvider(duetGatewayProvider());
    models.setProvider(vercelGatewayProvider());
    for (const { id } of connectedProviders()) {
      const provider = models.getProvider(id);
      if (provider) models.setProvider(withDuetManagedAuth(provider));
    }
    cached = { baseUrl, models };
  }
  return cached.models;
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
