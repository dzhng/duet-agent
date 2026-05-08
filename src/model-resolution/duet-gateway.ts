import { getModel, type Model } from "@earendil-works/pi-ai";

const PROVIDER_PREFIX = "duet-gateway";
const DEFAULT_BASE_URL = "https://duet.so/api/v1/ai-gateway";

/**
 * The Duet gateway proxies Vercel's AI Gateway 1:1 — same path layout, same
 * request/response contract — and authenticates with a `DUET_API_KEY` token
 * scoped to a single org. Rather than ship a parallel model registry, the
 * `duet-gateway` provider piggybacks on the underlying `vercel-ai-gateway`
 * model definitions and only swaps `baseUrl` to point at Duet (or a custom
 * URL via `DUET_GATEWAY_BASE_URL`).
 *
 * Auth flows through pi-ai's existing vercel-ai-gateway path, which reads
 * `AI_GATEWAY_API_KEY` — the CLI shims that env var from `DUET_API_KEY` at
 * startup so users only need to set the duet token.
 */

export const DUET_GATEWAY_PROVIDER = PROVIDER_PREFIX;
export const DUET_GATEWAY_API_KEY_ENV = "DUET_API_KEY";
export const DUET_GATEWAY_BASE_URL_ENV = "DUET_GATEWAY_BASE_URL";

export function isDuetGatewayModelName(modelName: string): boolean {
  return modelName.startsWith(`${PROVIDER_PREFIX}:`);
}

export function getDuetGatewayBaseUrl(): string {
  return process.env[DUET_GATEWAY_BASE_URL_ENV] ?? DEFAULT_BASE_URL;
}

/**
 * Resolve a `duet-gateway:<modelId>` string to a Model.
 *
 * Looks up the matching vercel-ai-gateway model and clones it with a Duet
 * gateway baseUrl. Returns undefined when the underlying gateway model
 * doesn't exist, mirroring `getModel`'s contract.
 */
export function resolveDuetGatewayModel(modelId: string): Model<any> | undefined {
  const upstream = getModel("vercel-ai-gateway" as any, modelId as any) as Model<any> | undefined;
  if (!upstream) return undefined;

  return {
    ...upstream,
    baseUrl: getDuetGatewayBaseUrl(),
  };
}

/**
 * If `DUET_API_KEY` is set but `AI_GATEWAY_API_KEY` is not, copy it across so
 * the underlying vercel-ai-gateway provider auth path resolves. Idempotent.
 *
 * Called early in CLI startup. No-op when either var is missing or
 * `AI_GATEWAY_API_KEY` is already set (caller wins).
 */
export function shimDuetApiKeyToAiGateway(): void {
  if (process.env.AI_GATEWAY_API_KEY) return;
  const duetKey = process.env[DUET_GATEWAY_API_KEY_ENV];
  if (!duetKey) return;
  process.env.AI_GATEWAY_API_KEY = duetKey;
}
