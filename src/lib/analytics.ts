import { resolveDuetAppBaseUrl } from "./duet-app-url.js";

/**
 * Send a typed CLI analytics event to the Duet public API. Best-effort: never
 * throws. If the network is down or the server returns non-2xx, we log a
 * warning (when a logger is provided) and move on so analytics never blocks
 * the user-facing flow.
 *
 * The server stamps `org_id` from the API key — callers don't pass it.
 */
export interface CaptureCliEventOptions {
  apiKey: string;
  name: "cli_login";
  /** Override the Duet app base URL; defaults to `resolveDuetAppBaseUrl()`. */
  appBaseUrl?: string;
  /** Inject HTTP for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Optional warning sink; defaults to silent. */
  logger?: (message: string) => void;
}

export async function captureCliEvent(options: CaptureCliEventOptions): Promise<void> {
  const baseUrl = options.appBaseUrl ?? resolveDuetAppBaseUrl();
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${baseUrl}/api/v1/analytics/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: options.name }),
    });
    if (!response.ok) {
      options.logger?.(
        `Analytics event '${options.name}' returned ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    options.logger?.(
      `Analytics event '${options.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
