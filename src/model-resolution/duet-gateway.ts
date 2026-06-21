import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai";
import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";

const GATEWAY_PATH = "/api/v1/ai-gateway";
const OPENAI_MODEL_PREFIX = "openai/";
const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The Duet gateway proxies Vercel's AI Gateway path layout and authenticates
 * with a `DUET_API_KEY` token scoped to a single org. Rather than ship a
 * parallel model registry, the `duet-gateway` provider piggybacks on upstream
 * model definitions and only swaps `baseUrl` to point at Duet.
 *
 * The base URL is `${DUET_APP_BASE_URL}${GATEWAY_PATH}`; users only need to
 * override the app origin via `DUET_APP_BASE_URL` (also used by `duet login`
 * and the CLI skill sync).
 *
 * Auth flows through pi-ai's existing vercel-ai-gateway path, which reads
 * `AI_GATEWAY_API_KEY` — the CLI shims that env var from `DUET_API_KEY` at
 * startup so users only need to set the duet token.
 */

export const DUET_GATEWAY_API_KEY_ENV = "DUET_API_KEY";

export function getDuetGatewayBaseUrl(): string {
  return `${resolveDuetAppBaseUrl()}${GATEWAY_PATH}`;
}

/**
 * Resolve a `duet-gateway:<modelId>` string to a Model.
 *
 * Anthropic models use pi-ai's Vercel AI Gateway catalog because that path is
 * already Anthropic-native. OpenAI models intentionally use pi-ai's OpenAI
 * catalog and the Duet gateway's OpenAI-compatible route instead; routing them
 * through the Anthropic-compatible gateway path drops OpenAI reasoning stream
 * semantics, so the TUI never sees reasoning/thinking events.
 *
 * Auth: the duet.so proxy only accepts `DUET_API_KEY`-style tokens and 500s on
 * a Vercel `vck_...` key. `resolveProviderApiKey("duet-gateway")` returns the
 * Duet token directly so the underlying transport always sends the right
 * credential, even when the user also has a real `AI_GATEWAY_API_KEY=vck_...`
 * set for explicit `vercel-ai-gateway:*` pins.
 */
export function resolveDuetGatewayModel(modelId: string): Model<any> {
  const upstream = resolveDuetGatewayUpstream(modelId);

  return {
    ...upstream,
    provider: "duet-gateway",
    id: modelId,
    baseUrl: getDuetGatewayBaseUrlForModel(upstream),
  };
}

/**
 * Resolve a gateway model id to its upstream spec, preferring pi-ai's catalog
 * and synthesizing a pass-through model when the catalog has not shipped the id
 * yet. The Duet gateway proxies Vercel's AI Gateway, which serves every
 * `provider/model` id over the anthropic-messages transport (OpenAI models keep
 * their native openai-responses transport for reasoning stream semantics), so a
 * newly listed model works the moment Vercel serves it — without a catalog or
 * code change here. When pi-ai later ships the model its real spec takes
 * precedence over the synthesized placeholder automatically.
 */
function resolveDuetGatewayUpstream(modelId: string): Model<any> {
  if (modelId.startsWith(OPENAI_MODEL_PREFIX)) {
    const slug = modelId.slice(OPENAI_MODEL_PREFIX.length);
    return (
      (getModel("openai" as any, slug as any) as Model<any> | undefined) ??
      synthesizePassthroughModel(modelId, "openai-responses")
    );
  }
  return (
    (getModel("vercel-ai-gateway" as any, modelId as any) as Model<any> | undefined) ??
    resolveMissingModel("vercel-ai-gateway", modelId) ??
    synthesizePassthroughModel(modelId, "anthropic-messages")
  );
}

/**
 * Build a minimal spec for a gateway model pi-ai's catalog has not shipped yet.
 * The context/output ceilings are intentionally conservative so an unknown
 * model never 400s on an over-advertised window; a model that needs a tighter
 * cap can still set `maxOutputTokens` in the catalog. `provider`/`baseUrl` are
 * placeholders that `resolveDuetGatewayModel` overwrites with the Duet proxy
 * route, so only `api` (which picks that route) and the limits matter here.
 */
function synthesizePassthroughModel(
  modelId: string,
  api: "anthropic-messages" | "openai-responses",
): Model<any> {
  const isOpenAI = api === "openai-responses";
  return {
    id: modelId,
    name: modelId,
    api,
    provider: isOpenAI ? "openai" : "vercel-ai-gateway",
    baseUrl: isOpenAI ? OPENAI_BASE_URL : VERCEL_GATEWAY_BASE_URL,
    reasoning: true,
    input: isOpenAI ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 64_000,
  };
}

/**
 * Opus 4.8 sibling cloned to synthesize Claude Fable 5 for the Vercel gateway
 * catalog, which pi-ai has not shipped there yet (Anthropic direct already
 * resolves it). Fable 5 reuses Opus 4.8's anthropic-messages transport, 1M
 * context window, and 128k output cap unchanged, so swapping the id yields a
 * correct spec — and a better one than the generic synthesized placeholder.
 * The `duet-gateway` route resolves through the `vercel-ai-gateway` catalog, so
 * this entry covers it too. `to` scopes the clone to Fable 5 so other
 * catalog-missing ids are not rewritten.
 */
const FABLE_5_CLONE_SOURCES: Record<string, { from: string; to: string }> = {
  "vercel-ai-gateway": { from: "anthropic/claude-opus-4.8", to: "anthropic/claude-fable-5" },
};

/**
 * Clone a known sibling on the same provider to build a Model pi-ai has not
 * shipped yet; returns undefined when the provider/modelId pair is not a
 * pending clone. Shared by the `duet-gateway` path (above) and the
 * `vercel-ai-gateway` path in resolver.ts. Delete the Fable 5 entry once pi-ai
 * ships it to the gateway catalog and it resolves directly.
 */
export function resolveMissingModel(provider: string, modelId: string): Model<any> | undefined {
  const clone = FABLE_5_CLONE_SOURCES[provider];
  if (!clone || modelId !== clone.to) return undefined;
  const sibling = getModel(provider as any, clone.from as any) as Model<any> | undefined;
  return sibling ? { ...sibling, id: modelId, name: modelId } : undefined;
}

function getDuetGatewayBaseUrlForModel(model: Model<any>): string {
  if (model.api === "openai-completions" || model.api === "openai-responses") {
    return `${getDuetGatewayBaseUrl()}/v1`;
  }
  return getDuetGatewayBaseUrl();
}

/**
 * Resolve the API key for a provider, including the project-local
 * `duet-gateway` provider that pi-ai's built-in env-key map does not
 * know about.
 *
 * `resolveDuetGatewayModel` deliberately overrides `model.provider` to
 * `"duet-gateway"` so cost and usage telemetry attribute the call to
 * the Duet proxy rather than the upstream vercel-ai-gateway. The
 * tradeoff is that pi-ai's `getEnvApiKey(provider)` returns `undefined`
 * for `"duet-gateway"`, so the agent-loop's `getApiKey` callback and
 * any direct `complete()` call would silently send an empty API key
 * and fail with `Could not resolve authentication method` even when
 * `DUET_API_KEY` is set.
 *
 * This wrapper closes the gap: `"duet-gateway"` returns the Duet token
 * directly, every other provider falls through to pi-ai's normal
 * env-key resolution unchanged.
 */
export function resolveProviderApiKey(provider: string): string | undefined {
  if (provider === "duet-gateway") {
    return process.env[DUET_GATEWAY_API_KEY_ENV];
  }
  return getEnvApiKey(provider as Parameters<typeof getEnvApiKey>[0]);
}
