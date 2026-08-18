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
 * The catalog is the only source of a model's capabilities; nothing here
 * declares a model. That is what lets a newly served gateway model work with
 * no code change, and it is why a capability we send on the wire must either
 * come from the catalog or be named in `gatewayCapabilityGaps` below.
 *
 * Memoized on the gateway origin: `resolveGatewayModel` runs on every
 * model resolution — parent step, classifier, each subagent — and rebasing two
 * hundred catalog entries each time is pure waste. Tests move the origin
 * between cases, so the key is the origin rather than a plain once-flag.
 */
/**
 * A gateway route: where a request goes, and which credential it carries.
 *
 * The Duet gateway is a proxy in front of Vercel's — same catalog, same model
 * ids, same protocols — so the origin and the credential are the entire
 * difference between them. Every rule below is therefore written once against
 * a route rather than twice per gateway, and a third gateway of this shape
 * costs one entry rather than another parallel set of functions.
 */
export interface GatewayRoute {
  id: string;
  name: string;
  /** Read per call: the Duet origin is configurable, Vercel's is fixed. */
  origin(): string;
  auth(): ProviderAuth;
  /** Request headers the route needs on every model it serves. */
  headers(): Record<string, string> | undefined;
}

const DUET_GATEWAY: GatewayRoute = {
  id: "duet-gateway",
  name: "Duet Gateway",
  origin: getDuetGatewayBaseUrl,
  auth: () => ({ apiKey: envApiKeyAuth("Duet", [DUET_GATEWAY_API_KEY_ENV]) }),
  // Every duet-gateway model resolves through this route — parent step,
  // classifier, vision fallback, subagents and memory alike — so the routing
  // tier is claimed here rather than at each call site.
  headers: duetTierHeaders,
};

const VERCEL_GATEWAY: GatewayRoute = {
  id: VERCEL_GATEWAY_PROVIDER_ID,
  name: "Vercel AI Gateway",
  origin: () => VERCEL_GATEWAY_BASE_URL,
  // The transports and the model list are ours to decide; how Vercel
  // authenticates stays the catalog's to declare.
  auth: () => builtinGatewayAuth(),
  // The tier claim means something only to the Duet proxy, which bills
  // against it; Vercel would reject an unknown header's cost to no purpose.
  headers: () => undefined,
};

export const GATEWAY_ROUTES: readonly GatewayRoute[] = [DUET_GATEWAY, VERCEL_GATEWAY];

/** The route serving `providerId`, or undefined when it is not a gateway. */
export function gatewayRoute(providerId: string): GatewayRoute | undefined {
  return GATEWAY_ROUTES.find((route) => route.id === providerId);
}

function builtinGatewayAuth(): ProviderAuth {
  const builtin = builtinProviders().find(({ id }) => id === VERCEL_GATEWAY_PROVIDER_ID);
  if (!builtin) throw new Error(`Model catalog has no ${VERCEL_GATEWAY_PROVIDER_ID} provider`);
  return builtin.auth;
}

/**
 * The catalog rebased onto one gateway route, built once per route.
 *
 * `resolveGatewayModel` runs on every model resolution — parent step,
 * classifier, each subagent — so rebasing two hundred catalog entries per call
 * is pure waste. Route id and origin are the rebase's only inputs, so together
 * they are the key; tests move the origin between cases, which is why this is
 * not a plain once-flag.
 */
const gatewayModelsByRoute = new Map<string, Model<Api>[]>();

function gatewayModels(route: GatewayRoute): Model<Api>[] {
  const origin = route.origin();
  const key = `${route.id}@${origin}`;
  const cached = gatewayModelsByRoute.get(key);
  if (cached) return cached;
  const models = getBuiltinModels(VERCEL_GATEWAY_PROVIDER_ID).map((model) =>
    rebaseOntoGateway(model, route, origin),
  );
  gatewayModelsByRoute.set(key, models);
  return models;
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
function rebaseOntoGateway(model: Model<Api>, route: GatewayRoute, origin: string): Model<Api> {
  const api = gatewayApi(model);
  const gaps = gatewayCapabilityGaps(model.id);
  return {
    ...model,
    // A gap fills in what the catalog omits; it must not take the two nested
    // records with it, or the day the catalog ships one field here silently
    // drops the others.
    thinkingLevelMap: { ...model.thinkingLevelMap, ...gaps?.thinkingLevelMap },
    compat: { ...model.compat, ...gaps?.compat },
    api,
    // Rewritten so cost and usage telemetry attribute the call to the route
    // that served it rather than to the catalog it was declared in.
    provider: route.id,
    baseUrl: gatewayBaseUrlForApi(origin, api),
  };
}

/**
 * Capabilities both gateways serve that pi-ai's catalog does not yet describe.
 *
 * An entry here is a bug report against the catalog, not a place to declare a
 * model: it exists only while a capability we send on the wire has no catalog
 * field behind it, and it is deleted the moment one ships. Anything beyond
 * that — a price, a context window, a transport — belongs to the catalog, and
 * a second copy of it here would silently go stale.
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
 * A gateway as a first-class pi-ai provider.
 *
 * `auth` is why this is a provider rather than a bag of rewritten models: a
 * credential is resolved per provider, and `duet-gateway` is not an id pi-ai's
 * env-key map knows. Declaring it on the provider is what lets any call
 * resolve the token without being handed one.
 *
 * All three transports are declared because serialization belongs to the
 * provider: rewriting a model's `api` to one the provider does not implement
 * yields a model that claims Responses and is sent as Anthropic, silently
 * dropping reasoning effort and mangling tool-result images.
 */
export function gatewayProvider(route: GatewayRoute): Provider {
  return createProvider({
    id: route.id,
    name: route.name,
    baseUrl: route.origin(),
    auth: route.auth(),
    models: gatewayModels(route),
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}

/**
 * Resolve a `<gateway>:<modelId>` string to a Model.
 *
 * An id the catalog has not shipped still resolves: a gateway serves a model
 * the moment its vendor lists it, and waiting for a catalog release to use it
 * is the coupling this module exists to avoid. The synthesized entry is
 * deliberately conservative so an unknown model never 400s on an
 * over-advertised window.
 */
export function resolveGatewayModel(route: GatewayRoute, modelId: string): Model<Api> {
  const declared = gatewayModels(route).find((model) => model.id === modelId);
  const model =
    declared ?? rebaseOntoGateway(synthesizePassthroughModel(modelId), route, route.origin());
  // Applied here rather than in the rebase: the rebased list is memoized per
  // route, but the routing tier changes within a session — a mid-turn `/model`
  // switch retargets attribution — so a header baked in at build time would
  // report whichever tier happened to be active when the list was first built.
  const headers = route.headers();
  return headers ? { ...model, headers: { ...model.headers, ...headers } } : model;
}

/**
 * Build a minimal spec for a gateway model the catalog has not shipped yet.
 * OpenAI ids keep the Responses transport and its native vision support; every
 * other unknown id is assumed text-only until the catalog says otherwise.
 */
function synthesizePassthroughModel(modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    // `provider`, `baseUrl` and `api` are required fields the rebase then
    // decides for real; only `input` survives, and it is what tells the rebase
    // which transport can carry this model.
    provider: VERCEL_GATEWAY_PROVIDER_ID,
    baseUrl: VERCEL_GATEWAY_BASE_URL,
    api: "anthropic-messages",
    reasoning: true,
    input: modelId.startsWith(OPENAI_MODEL_PREFIX) ? ["text", "image"] : ["text"],
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
 * A gateway rebase deliberately rewrites `model.provider` to
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
