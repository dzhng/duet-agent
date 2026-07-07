/**
 * Resolve the base URL of the Duet web app.
 *
 * `DUET_APP_BASE_URL` controls the app origin used by login, skill sync,
 * embeddings, analytics, and feedback. Model gateway traffic can use
 * `DUET_GATEWAY_BASE_URL`; when unset, the gateway still falls back to this app
 * origin plus `/api/v1/ai-gateway` for chat-app compatibility.
 */

const DEFAULT_BASE_URL = "https://duet.so";
export const DUET_APP_BASE_URL_ENV = "DUET_APP_BASE_URL";

export function resolveDuetAppBaseUrl(): string {
  const override = process.env[DUET_APP_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_BASE_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
