import { getEnvApiKey, getModel, type Model } from "@earendil-works/pi-ai";
import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";

const GATEWAY_PATH = "/api/v1/ai-gateway";
const OPENAI_MODEL_PREFIX = "openai/";

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
 * a Vercel `vck_...` key. We force `AI_GATEWAY_API_KEY` to the Duet token here
 * so the underlying vercel-ai-gateway transport sends the right credential
 * even when the user has both keys set in their env file.
 */
export function resolveDuetGatewayModel(modelId: string): Model<any> | undefined {
  forceDuetGatewayAuth();
  const upstream = resolveDuetGatewayUpstream(modelId);
  if (!upstream) return undefined;

  return {
    ...upstream,
    provider: "duet-gateway",
    id: modelId,
    baseUrl: getDuetGatewayBaseUrlForModel(upstream),
  };
}

function resolveDuetGatewayUpstream(modelId: string): Model<any> | undefined {
  if (modelId.startsWith(OPENAI_MODEL_PREFIX)) {
    return getModel("openai" as any, modelId.slice(OPENAI_MODEL_PREFIX.length) as any) as
      | Model<any>
      | undefined;
  }
  return getModel("vercel-ai-gateway" as any, modelId as any) as Model<any> | undefined;
}

function getDuetGatewayBaseUrlForModel(model: Model<any>): string {
  if (model.api === "openai-completions" || model.api === "openai-responses") {
    return `${getDuetGatewayBaseUrl()}/v1`;
  }
  return getDuetGatewayBaseUrl();
}

/**
 * If `DUET_API_KEY` is set but `AI_GATEWAY_API_KEY` is not, copy it across so
 * the underlying vercel-ai-gateway provider auth path resolves.
 *
 * Called early in CLI startup. Conservative: does not clobber an existing
 * `AI_GATEWAY_API_KEY`, so a user who explicitly pinned `vercel-ai-gateway:*`
 * with a real Vercel key still works. The duet-gateway model path takes a
 * stricter route via `forceDuetGatewayAuth` because the duet.so proxy will
 * not accept a Vercel-issued key.
 */
export function shimDuetApiKeyToAiGateway(): void {
  if (process.env.AI_GATEWAY_API_KEY) return;
  const duetKey = process.env[DUET_GATEWAY_API_KEY_ENV];
  if (!duetKey) return;
  process.env.AI_GATEWAY_API_KEY = duetKey;
}

/**
 * Overwrite `AI_GATEWAY_API_KEY` with `DUET_API_KEY` so vercel-ai-gateway's
 * transport authenticates against the Duet proxy with the right token. Called
 * only when we're about to issue a request to duet.so, where a `vck_...` key
 * produces an opaque 500.
 */
function forceDuetGatewayAuth(): void {
  const duetKey = process.env[DUET_GATEWAY_API_KEY_ENV];
  if (!duetKey) return;
  process.env.AI_GATEWAY_API_KEY = duetKey;
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
