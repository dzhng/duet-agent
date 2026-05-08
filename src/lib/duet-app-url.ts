/**
 * Resolve the base URL of the Duet web app from the existing
 * `DUET_GATEWAY_BASE_URL` env var.
 *
 * The CLI talks to two URLs hosted on the same origin:
 *   - the AI gateway proxy at `<base>/api/v1/ai-gateway/...` (used by the
 *     `duet-gateway` model provider), and
 *   - the new CLI auth/sync endpoints at `<base>/cli/login` and
 *     `<base>/api/v1/cli/...`.
 *
 * `DUET_GATEWAY_BASE_URL` is the existing env var users already set to point
 * the gateway provider at staging/dev (e.g.
 * `https://staging.duet.so/api/v1/ai-gateway`). Stripping the well-known
 * suffix gives us the app origin for the CLI endpoints, so a single env var
 * re-points everything.
 */

const DEFAULT_BASE_URL = "https://duet.so";
const GATEWAY_BASE_URL_ENV = "DUET_GATEWAY_BASE_URL";
const GATEWAY_PATH_SUFFIX = "/api/v1/ai-gateway";

export function resolveDuetAppBaseUrl(): string {
  const gateway = process.env[GATEWAY_BASE_URL_ENV]?.trim();
  if (gateway && gateway.endsWith(GATEWAY_PATH_SUFFIX)) {
    return stripTrailingSlash(gateway.slice(0, -GATEWAY_PATH_SUFFIX.length));
  }
  return DEFAULT_BASE_URL;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
