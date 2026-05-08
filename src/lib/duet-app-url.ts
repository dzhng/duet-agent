/**
 * Resolve the base URL of the Duet web app.
 *
 * Single env var (`DUET_APP_BASE_URL`) for the app origin. Surface-specific
 * paths like the AI gateway's `/api/v1/ai-gateway` and the CLI's
 * `/api/v1/cli/*` are hardcoded by their callers.
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
