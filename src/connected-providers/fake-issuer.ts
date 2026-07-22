import {
  pollOAuthDeviceCodeFlow,
  registerOAuthProvider,
  type OAuthCredentials,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import type { ConnectedProviderId } from "./store.js";

export const FAKE_ISSUER_ENV = "DUET_CONNECT_FAKE_ISSUER_URL";

/** Concrete RFC-8628 contract imported by both client and issuer conformance tests. */
export const FAKE_ISSUER_WIRE_TABLE = {
  deviceCode: {
    method: "POST",
    path: "/device/code",
    request: { client_id: "duet-agent:openai-codex", scope: "openid profile email" },
    response: {
      device_code: "fixture-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://issuer.test/device",
      interval: 1,
      expires_in: 600,
    },
  },
  pendingToken: {
    method: "POST",
    path: "/token",
    request: {
      device_code: "fixture-device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    response: { status: "pending" },
  },
  approvedToken: {
    method: "POST",
    path: "/token",
    request: {
      device_code: "fixture-device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    response: {
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      expires_in: 3600,
      account_id: "fixture-account",
    },
  },
  refreshToken: {
    method: "POST",
    path: "/token",
    request: { refresh_token: "fixture-refresh-token", grant_type: "refresh_token" },
    response: {
      access_token: "fixture-rotated-access-token",
      refresh_token: "fixture-rotated-refresh-token",
      expires_in: 3600,
      account_id: "fixture-account",
    },
  },
} as const;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface TokenResponse {
  status?: "pending" | "slow_down" | "denied" | "expired";
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
}

let installedBaseUrl: string | undefined;
let installedProviders: readonly OAuthProviderInterface[] | undefined;

/** Registers fake providers through pi-ai only when explicitly enabled. */
export function installFakeIssuerIfConfigured(
  env: Record<string, string | undefined> = process.env,
): "installed" | "skipped" {
  const configured = env[FAKE_ISSUER_ENV]?.trim();
  if (!configured) return "skipped";
  const baseUrl = configured.replace(/\/+$/, "");
  if (installedBaseUrl !== baseUrl || !installedProviders) {
    installedBaseUrl = baseUrl;
    installedProviders = [
      createFakeProvider("openai-codex", "ChatGPT", baseUrl),
      createFakeProvider("github-copilot", "GitHub Copilot", baseUrl),
    ];
  }
  for (const provider of installedProviders) registerOAuthProvider(provider);
  return "installed";
}

function createFakeProvider(
  id: ConnectedProviderId,
  name: string,
  baseUrl: string,
): OAuthProviderInterface {
  return {
    id,
    name,
    async login(callbacks) {
      const device = await postJson<DeviceCodeResponse>(`${baseUrl}/device/code`, {
        client_id: `duet-agent:${id}`,
        scope: id === "openai-codex" ? "openid profile email" : "read:user",
      });
      callbacks.onDeviceCode({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        intervalSeconds: device.interval,
        expiresInSeconds: device.expires_in,
      });
      return pollOAuthDeviceCodeFlow({
        intervalSeconds: device.interval,
        expiresInSeconds: device.expires_in,
        signal: callbacks.signal,
        poll: async () =>
          tokenPollResult(
            await postJson<TokenResponse>(`${baseUrl}/token`, {
              device_code: device.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          ),
      });
    },
    async refreshToken(credentials) {
      const token = await postJson<TokenResponse>(`${baseUrl}/token`, {
        refresh_token: credentials.refresh,
        grant_type: "refresh_token",
      });
      return credentialsFromToken(token, credentials.refresh);
    },
    getApiKey(credentials) {
      return credentials.access;
    },
    modifyModels(models) {
      return models.map((model) => ({
        ...model,
        api: "openai-completions",
        baseUrl,
        compat: {
          ...model.compat,
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      }));
    },
  };
}

function tokenPollResult(
  response: TokenResponse,
):
  | { status: "pending" | "slow_down" }
  | { status: "failed"; message: string }
  | { status: "complete"; value: OAuthCredentials } {
  if (response.status === "pending" || response.status === "slow_down") {
    return { status: response.status };
  }
  if (response.status === "denied") {
    return { status: "failed", message: "Device login denied." };
  }
  if (response.status === "expired") {
    return { status: "failed", message: "Device login expired." };
  }
  try {
    return { status: "complete", value: credentialsFromToken(response) };
  } catch {
    return { status: "failed", message: "Device token response was malformed." };
  }
}

function credentialsFromToken(response: TokenResponse, previousRefresh?: string): OAuthCredentials {
  if (
    typeof response.access_token !== "string" ||
    typeof response.expires_in !== "number" ||
    (typeof response.refresh_token !== "string" && previousRefresh === undefined)
  ) {
    throw new Error("Device token response was malformed.");
  }
  return {
    access: response.access_token,
    refresh: response.refresh_token ?? previousRefresh!,
    expires: Date.now() + response.expires_in * 1000,
    ...(response.account_id === undefined ? {} : { accountId: response.account_id }),
  };
}

async function postJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fake issuer request failed (${response.status}).`);
  return (await response.json()) as T;
}
