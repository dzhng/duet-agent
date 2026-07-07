import { resolveDuetApiBaseUrl } from "./duet-api-url.js";

/**
 * Source identifier stamped on every CLI/TUI feedback row so the admin
 * inbox can distinguish them from the in-product web sidebar dialog.
 */
export const DUET_AGENT_FEEDBACK_SOURCE = "duet-agent-cli";

export interface SubmitFeedbackOptions {
  content: string;
  /** Override the source string used by web admin filters. */
  source?: string;
  /** Inject a stand-in for fetch so tests can intercept the upload. */
  fetch?: typeof fetch;
}

export interface SubmitFeedbackResult {
  /** Base URL the feedback was POSTed to, for confirmation messages. */
  baseUrl: string;
}

/**
 * POST a free-form markdown feedback string to the Duet API's public
 * feedback endpoint. Shared between `duet send-feedback` (CLI) and the
 * `/feedback` TUI slash command. The endpoint is intentionally
 * unauthenticated — anonymous notes are fine.
 *
 * Throws on non-2xx responses so callers can surface the error in their
 * own UI surface (stderr for the CLI, an error block for the TUI).
 */
export async function submitDuetFeedback(
  options: SubmitFeedbackOptions,
): Promise<SubmitFeedbackResult> {
  const trimmed = options.content.trim();
  if (!trimmed) throw new Error("Feedback content is required.");

  const baseUrl = resolveDuetApiBaseUrl();
  const url = `${baseUrl}/v1/feedback`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: trimmed,
      source: options.source ?? DUET_AGENT_FEEDBACK_SOURCE,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Feedback submission failed (${response.status}): ${text || response.statusText}`,
    );
  }

  return { baseUrl };
}
