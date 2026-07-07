/**
 * Resolve the Duet API origin used by CLI-side product endpoints, currently
 * device login and feedback. Staging deployments can override it via
 * `DUET_API_BASE_URL` without changing gateway model routing
 * (`DUET_GATEWAY_BASE_URL`).
 */

const DEFAULT_API_BASE_URL = "https://ctl.duet.so";
export const DUET_API_BASE_URL_ENV = "DUET_API_BASE_URL";

export function resolveDuetApiBaseUrl(): string {
  const override = process.env[DUET_API_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);
  return DEFAULT_API_BASE_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
