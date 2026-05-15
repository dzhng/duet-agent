import { getModel, type Model } from "@earendil-works/pi-ai";
import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";

const GATEWAY_PATH = "/api/v1/ai-gateway";

/**
 * The Duet gateway proxies Vercel's AI Gateway 1:1 — same path layout, same
 * request/response contract — and authenticates with a `DUET_API_KEY` token
 * scoped to a single org. Rather than ship a parallel model registry, the
 * `duet-gateway` provider piggybacks on the underlying `vercel-ai-gateway`
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
 * Looks up the matching vercel-ai-gateway model and clones it with a Duet
 * gateway baseUrl. Returns undefined when the underlying gateway model
 * doesn't exist, mirroring `getModel`'s contract.
 *
 * Auth: the duet.so proxy only accepts `DUET_API_KEY`-style tokens and 500s on
 * a Vercel `vck_...` key. We force `AI_GATEWAY_API_KEY` to the Duet token here
 * so the underlying vercel-ai-gateway transport sends the right credential
 * even when the user has both keys set in their env file.
 */
export function resolveDuetGatewayModel(modelId: string): Model<any> | undefined {
  forceDuetGatewayAuth();
  const upstream = getModel("vercel-ai-gateway" as any, modelId as any) as Model<any> | undefined;
  if (!upstream) return undefined;

  return {
    ...upstream,
    baseUrl: getDuetGatewayBaseUrl(),
  };
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
