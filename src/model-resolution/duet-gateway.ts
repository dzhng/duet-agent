import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Provider,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { isConnectedProviderId } from "../connected-providers/store.js";
import { activeDuetTier } from "../model-routing/active-tier.js";
import {
  connectedProviderApiKey,
  refreshConnectedTokenInBackground,
} from "../connected-providers/tokens.js";

/** Request header the product reads to attribute a gateway call to a tier. */
export const DUET_TIER_HEADER = "x-duet-tier";

/**
 * The active routing tier as request headers, or undefined for a concrete pin.
 *
 * The Duet proxy 403s unclaimed generations for non-internal models
 * (`tier_not_allowed`), so every transport that bills through the gateway —
 * pi-resolved models, the AI SDK client, the embeddings fetch — spreads this
 * claim into its request headers. Undefined rather than `{}` so call sites can
 * keep the header key entirely absent on pinned traffic.
 */
export function duetTierHeaders(): Record<string, string> | undefined {
  const tier = activeDuetTier();
  return tier === undefined ? undefined : { [DUET_TIER_HEADER]: tier };
}

const DEFAULT_DUET_GATEWAY_BASE_URL = "https://gateway.duet.so";
const OPENAI_MODEL_PREFIX = "openai/";
const ANTHROPIC_MODEL_PREFIX = "anthropic/";
const DUET_GATEWAY_PROVIDER_ID = "duet-gateway";
const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const VERCEL_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
/**
 * The Duet gateway proxies Vercel's AI Gateway path layout and authenticates
 * with a `DUET_API_KEY` token scoped to a single org. `DUET_GATEWAY_BASE_URL`
 * points model traffic at a different origin; unset, it goes to
 * `https://gateway.duet.so`.
 */
export const DUET_GATEWAY_API_KEY_ENV = "DUET_API_KEY";
export const DUET_GATEWAY_BASE_URL_ENV = "DUET_GATEWAY_BASE_URL";

export function getDuetGatewayBaseUrl(): string {
  const override = process.env[DUET_GATEWAY_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_DUET_GATEWAY_BASE_URL;
}

/**
 * Every model the Duet gateway serves, declared from pi-ai's Vercel AI Gateway
 * catalog and rebased onto the Duet proxy.
 *
 * This used to be a table of hand-written capability overrides and
 * clone-a-sibling rules, because pi-ai's catalog shipped on its own schedule
 * and a model we wanted before then had no entry. pi-ai 0.84.2 lets a consumer
 * declare its own provider, and its catalog already carries every id that
 * table covered — so the table is gone and a newly served gateway model needs
 * no code here at all.
 *
 * Memoized on the gateway origin: `resolveDuetGatewayModel` runs on every
 * model resolution — parent step, classifier, each subagent — and rebasing two
 * hundred catalog entries each time is pure waste. Tests move the origin
 * between cases, so the key is the origin rather than a plain once-flag.
 */
let cachedGatewayModels: { baseUrl: string; models: Model<Api>[] } | undefined;

function duetGatewayModels(): Model<Api>[] {
  const baseUrl = getDuetGatewayBaseUrl();
  if (cachedGatewayModels?.baseUrl !== baseUrl) {
    cachedGatewayModels = {
      baseUrl,
      models: getBuiltinModels("vercel-ai-gateway").map((model) => rebaseOntoDuetGateway(model)),
    };
  }
  return cachedGatewayModels.models;
}

let cachedVercelModels: Model<Api>[] | undefined;

function vercelGatewayModels(): Model<Api>[] {
  cachedVercelModels ??= getBuiltinModels(VERCEL_GATEWAY_PROVIDER_ID).map((model) =>
    rebaseOntoVercelGateway(model),
  );
  return cachedVercelModels;
}

/**
 * The transport a gateway model runs over.
 *
 * Both gateways serve the whole catalog over the same protocol surface — pi-ai
 * declares every `vercel-ai-gateway` model as `anthropic-messages` — so the
 * choice is per model, not per gateway, and `duet-gateway` and
 * `vercel-ai-gateway` make it identically.
 *
 * Anthropic's own models keep the Anthropic transport, which is native for
 * them. Everything else that accepts images moves to OpenAI completions,
 * because the two transports disagree about where a tool result's image goes:
 * the Anthropic serializer leaves it inside the `tool_result` block, and
 * Vercel's translation to an OpenAI-shaped provider has nowhere to put it, so
 * it arrives as text. Measured against `moonshotai/kimi-k3`, one 512x512 PNG
 * costs 147,554 tokens that way and 650 when the OpenAI serializer hoists it
 * into the following user message — which it already does, unprompted.
 *
 * OpenAI's own models stay on the Responses transport: routing them through
 * either compatible path drops reasoning stream semantics and silently ignores
 * `reasoningEffort`.
 */
function gatewayApi(model: Model<Api>): Api {
  if (model.id.startsWith(OPENAI_MODEL_PREFIX)) return "openai-responses";
  if (model.id.startsWith(ANTHROPIC_MODEL_PREFIX)) return model.api;
  return model.input.includes("image") ? "openai-completions" : model.api;
}

/**
 * Point a catalog model at a gateway: its own transport, that gateway's origin,
 * and the capabilities the catalog is missing.
 *
 * `provider` is deliberately rewritten for the Duet gateway so cost and usage
 * telemetry attribute the call to the Duet proxy rather than to Vercel.
 */
function rebaseOntoGateway(model: Model<Api>, origin: string, provider?: string): Model<Api> {
  const api = gatewayApi(model);
  return {
    ...model,
    ...gatewayCapabilityGaps(model.id),
    api,
    ...(provider ? { provider } : {}),
    baseUrl: gatewayBaseUrlForApi(origin, api),
  };
}

/** A gateway model rebased onto the Duet proxy. */
function rebaseOntoDuetGateway(model: Model<Api>): Model<Api> {
  return rebaseOntoGateway(model, getDuetGatewayBaseUrl(), DUET_GATEWAY_PROVIDER_ID);
}

/** The same model as served by Vercel's gateway directly. */
export function rebaseOntoVercelGateway(model: Model<Api>): Model<Api> {
  return rebaseOntoGateway(model, VERCEL_GATEWAY_BASE_URL);
}

/**
 * Capabilities both gateways serve that pi-ai's catalog does not yet describe.
 *
 * This is the last remnant of what used to be a table of hand-written model
 * specs. An entry here is a bug report against the catalog, not a place to
 * declare a model: it exists only while a capability we send on the wire has
 * no catalog field behind it, and it is deleted the moment one ships.
 */
function gatewayCapabilityGaps(modelId: string): Partial<Model<Api>> | undefined {
  // GLM 5.2's maximum reasoning mode is reached with `"max"`; without the map
  // the product's `xhigh` setting reaches the wire as a level GLM ignores.
  if (modelId === "zai/glm-5.2") {
    return { thinkingLevelMap: { xhigh: "max" }, compat: { forceAdaptiveThinking: true } };
  }
  return undefined;
}

/**
 * The Duet gateway as a first-class pi-ai provider.
 *
 * `auth` is the reason this is a provider rather than a bag of rewritten
 * models: pi-ai resolves a credential per provider, and `duet-gateway` is not
 * an id its env-key map knows, so every call used to need a wrapper to avoid
 * sending an empty key. Declaring the env var here closes that structurally.
 */
export function duetGatewayProvider(): Provider {
  return gatewayProvider({
    id: DUET_GATEWAY_PROVIDER_ID,
    name: "Duet Gateway",
    baseUrl: getDuetGatewayBaseUrl(),
    auth: { apiKey: envApiKeyAuth("Duet", [DUET_GATEWAY_API_KEY_ENV]) },
    models: duetGatewayModels(),
  });
}

/**
 * Vercel's gateway, re-declared so a `vercel-ai-gateway:` pin reaches the same
 * transports the Duet proxy does.
 *
 * pi-ai ships this provider with only the Anthropic API implementation, and
 * serialization belongs to the provider — so rewriting a model's `api` on its
 * own produces a model that claims Responses and is sent as Anthropic, losing
 * reasoning effort and mangling tool-result images. The gateway itself serves
 * all three protocols; this says so.
 */
export function vercelGatewayProvider(): Provider {
  const builtin = builtinProviders().find(({ id }) => id === VERCEL_GATEWAY_PROVIDER_ID);
  return gatewayProvider({
    id: VERCEL_GATEWAY_PROVIDER_ID,
    name: builtin?.name ?? "Vercel AI Gateway",
    baseUrl: VERCEL_GATEWAY_BASE_URL,
    // Only the transports and the model list change; how Vercel authenticates
    // is still pi-ai's to declare.
    auth: builtin?.auth ?? { apiKey: envApiKeyAuth("Vercel AI Gateway", ["AI_GATEWAY_API_KEY"]) },
    models: vercelGatewayModels(),
  });
}

/** Both gateways front the same catalog over the same three protocols. */
function gatewayProvider(options: {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: Model<Api>[];
}): Provider {
  return createProvider({
    id: options.id,
    name: options.name,
    baseUrl: options.baseUrl,
    auth: options.auth,
    models: options.models,
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}

/**
 * Resolve a `duet-gateway:<modelId>` string to a Model.
 *
 * An id the catalog has not shipped still resolves: the gateway serves a model
 * the moment Vercel lists it, and waiting for a catalog release to use it is
 * the coupling this whole module exists to avoid. The synthesized entry is
 * deliberately conservative so an unknown model never 400s on an
 * over-advertised window.
 */
export function resolveDuetGatewayModel(modelId: string): Model<Api> {
  const declared = duetGatewayModels().find((model) => model.id === modelId);
  const model = declared ?? rebaseOntoDuetGateway(synthesizePassthroughModel(modelId));
  // Every duet-gateway model is built here — parent step, classifier, vision
  // fallback, subagents and memory alike — so stamping the routing tier once
  // at this seam attributes all of them without per-call-site plumbing. Never
  // added to other transports.
  const tierHeaders = duetTierHeaders();
  return tierHeaders ? { ...model, headers: { ...model.headers, ...tierHeaders } } : model;
}

/**
 * Build a minimal spec for a gateway model the catalog has not shipped yet.
 * OpenAI ids keep the Responses transport and its native vision support; every
 * other unknown id is assumed text-only until the catalog says otherwise.
 */
function synthesizePassthroughModel(modelId: string): Model<Api> {
  const isOpenAI = modelId.startsWith(OPENAI_MODEL_PREFIX);
  return {
    id: modelId,
    name: modelId,
    api: isOpenAI ? "openai-responses" : "anthropic-messages",
    provider: DUET_GATEWAY_PROVIDER_ID,
    baseUrl: VERCEL_GATEWAY_BASE_URL,
    reasoning: true,
    input: isOpenAI ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 64_000,
  };
}

/** OpenAI-compatible transports live under the gateway's `/v1` route. */
function gatewayBaseUrlForApi(origin: string, api: Api): string {
  const openAiCompatible = api === "openai-completions" || api === "openai-responses";
  return openAiCompatible ? `${origin}/v1` : origin;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * The API key to send for a provider, resolved the way Duet stores keys.
 *
 * Two kinds of caller need this. Connected providers (ChatGPT, Copilot) keep
 * their token in Duet's own store, which pi-ai cannot see at all. And the
 * api-dispatch `complete()` used for structured output does no provider auth
 * resolution whatsoever, so it needs the key handed to it — including for
 * `duet-gateway`, an id pi-ai's env-key map does not know.
 *
 * `resolveDuetGatewayModel` deliberately rewrites `model.provider` to
 * `"duet-gateway"` so cost and usage telemetry attribute the call to the Duet
 * proxy rather than to Vercel; that rename is what puts the id outside pi-ai's
 * map in the first place.
 */
export function resolveProviderApiKey(provider: string): string | undefined {
  if (provider === DUET_GATEWAY_PROVIDER_ID) {
    return process.env[DUET_GATEWAY_API_KEY_ENV];
  }
  if (isConnectedProviderId(provider)) {
    const token = connectedProviderApiKey(provider);
    if (!token) refreshConnectedTokenInBackground(provider);
    return token;
  }
  return getEnvApiKey(provider as Parameters<typeof getEnvApiKey>[0]);
}
