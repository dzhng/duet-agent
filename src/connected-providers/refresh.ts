import { githubCopilotOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { ConnectedProviderId, OAuthCredentials } from "./store.js";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_SCOPE = "openid profile email";

type FetchToken = (input: string, init: RequestInit) => Promise<Response>;

/** Refresh one connected-provider credential using the provider's supported OAuth flow. */
export async function refreshConnectedCredentials(
  provider: ConnectedProviderId,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (provider === "github-copilot") {
    return githubCopilotOAuthProvider.refreshToken(credentials);
  }
  return refreshOpenAICodexCredentials(credentials.refresh);
}

/**
 * Refresh ChatGPT credentials with the scope pi-ai currently omits. OpenAI
 * rotates refresh tokens, so the caller must replace the stored credential
 * object with this complete result rather than patching only `access`.
 */
export async function refreshOpenAICodexCredentials(
  refreshToken: string,
  fetchImpl: FetchToken = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: OPENAI_CODEX_SCOPE,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  const value: unknown = await response.json();
  if (!isTokenResponse(value)) {
    throw new Error("OpenAI Codex token refresh response missing required fields");
  }
  const accountId = accountIdFromAccessToken(value.access_token);
  if (!accountId) throw new Error("Failed to extract accountId from refreshed OpenAI Codex token");
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: now() + value.expires_in * 1_000,
    accountId,
  };
}

interface OpenAITokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function isTokenResponse(value: unknown): value is OpenAITokenResponse {
  if (value === null || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.access_token === "string" &&
    typeof token.refresh_token === "string" &&
    typeof token.expires_in === "number"
  );
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded === null || typeof decoded !== "object") return undefined;
    const auth = (decoded as Record<string, unknown>)["https://api.openai.com/auth"];
    if (auth === null || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}
