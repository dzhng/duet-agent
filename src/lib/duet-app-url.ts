/**
 * Resolve the base URL of the Duet web app.
 *
 * The CLI talks to two URLs hosted on the same origin:
 *   - the AI gateway proxy at `<base>/api/v1/ai-gateway/...` (already used by
 *     the duet-gateway provider), and
 *   - the new CLI auth/sync endpoints at `<base>/cli/login` and
 *     `<base>/api/v1/cli/...`.
 *
 * Override the base via `DUET_APP_BASE_URL` for staging/dev. As a fallback,
 * derive it from `DUET_GATEWAY_BASE_URL` by stripping the `/api/v1/ai-gateway`
 * suffix so a single env var can re-point both surfaces.
 */

const DEFAULT_BASE_URL = "https://duet.so";
const APP_BASE_URL_ENV = "DUET_APP_BASE_URL";
const GATEWAY_BASE_URL_ENV = "DUET_GATEWAY_BASE_URL";
const GATEWAY_PATH_SUFFIX = "/api/v1/ai-gateway";

export function resolveDuetAppBaseUrl(): string {
  const override = process.env[APP_BASE_URL_ENV]?.trim();
  if (override) return stripTrailingSlash(override);

  const gateway = process.env[GATEWAY_BASE_URL_ENV]?.trim();
  if (gateway && gateway.endsWith(GATEWAY_PATH_SUFFIX)) {
    return stripTrailingSlash(gateway.slice(0, -GATEWAY_PATH_SUFFIX.length));
  }

  return DEFAULT_BASE_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
