import { createGateway } from "ai";
import { getDuetGatewayBaseUrl } from "./duet-gateway.js";

/**
 * The `duet model` subcommand talks to models directly through the Vercel AI
 * SDK (`ai@^7`), pointed at the Duet gateway instead of the pi harness. The
 * gateway provider speaks the versioned `/v4/ai` protocol path, and
 * `/v1/models` serves the catalog. Auth is the workspace-scoped `DUET_API_KEY`
 * Bearer token.
 */
export const DUET_API_KEY_ENV = "DUET_API_KEY";

// Generation can be slow — image/video models routinely run for minutes — so
// requests get a 15-minute ceiling rather than the SDK/runtime default.
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;

/** Capability classes the gateway tags each model with via `/v1/models`. */
export type ModelType =
  | "language"
  | "image"
  | "video"
  | "embedding"
  | "realtime"
  | "reranking"
  | "speech"
  | "transcription";

/**
 * Build an AI SDK gateway provider bound to the Duet proxy. Callers resolve a
 * model with `gateway('<provider>/<model>')` and pass it to `generateText`,
 * `generateImage`, etc. The base URL appends `/v4/ai` to the gateway origin —
 * the protocol version the duet.so proxy currently serves. The custom `fetch`
 * only raises the abort timeout; everything else is the platform default.
 */
export function createDuetModelGateway(): ReturnType<typeof createGateway> {
  // Preserve `fetch.preconnect` so the wrapper still satisfies the platform
  // fetch signature; only the abort timeout is overridden.
  const longTimeoutFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) }),
    { preconnect: fetch.preconnect },
  );
  // Credential precedence mirrors the harness: the Duet proxy when its key is
  // present, else Vercel's AI Gateway (same /v4/ai protocol path) with the
  // Vercel key. One owner for this fallback — callers never bridge env vars.
  const duetKey = process.env[DUET_API_KEY_ENV]?.trim();
  const vercelKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const upstream =
    duetKey || !vercelKey
      ? { baseURL: `${getDuetGatewayBaseUrl()}/v4/ai`, apiKey: process.env[DUET_API_KEY_ENV] }
      : { baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: vercelKey };
  return createGateway({ ...upstream, fetch: longTimeoutFetch });
}

/**
 * Fetch the gateway model catalog and return a map of model id -> capability
 * type. Used to validate a requested model and route it to the right generation
 * call (text vs image vs video). Hits `/v1/models` directly because the catalog
 * is an org-scoped read, not a generation, so it bypasses the SDK provider.
 */
export async function fetchModelCatalog(): Promise<Map<string, ModelType>> {
  const response = await fetch(`${getDuetGatewayBaseUrl()}/v1/models`, {
    headers: { Authorization: `Bearer ${process.env[DUET_API_KEY_ENV] ?? ""}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch model catalog: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { data?: Array<{ id: string; type: ModelType }> };
  const catalog = new Map<string, ModelType>();
  for (const model of body.data ?? []) {
    catalog.set(model.id, model.type);
  }
  return catalog;
}
