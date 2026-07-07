/**
 * Resolve Duet product origins used by CLI-side product endpoints.
 *
 * `DUET_APP_BASE_URL` controls duet.so web-origin endpoints that still live on
 * the product surface, currently default skill sync and best-effort analytics.
 * It does not affect model gateway traffic, device login, embeddings, or
 * feedback; those use their dedicated gateway/API origins.
 *
 * `DUET_API_BASE_URL` controls the new Duet API origin used by device login and
 * feedback. Staging deployments can override it without changing gateway model
 * routing or duet.so web-origin behavior.
 */

const DEFAULT_BASE_URL = "https://duet.so";
const DEFAULT_API_BASE_URL = "https://ctl.duet.so";
export const DUET_APP_BASE_URL_ENV = "DUET_APP_BASE_URL";
export const DUET_API_BASE_URL_ENV = "DUET_API_BASE_URL";

export function resolveDuetAppBaseUrl(): string {
  const override = process.env[DUET_APP_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_BASE_URL;
}

export function resolveDuetApiBaseUrl(): string {
  const override = process.env[DUET_API_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_API_BASE_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
