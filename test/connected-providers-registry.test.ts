import { afterEach, describe, expect, test } from "bun:test";
import {
  connectedProviders,
  resolveConnectedProviderAlias,
} from "../src/connected-providers/registry.js";
import {
  FAKE_ISSUER_ENV,
  FAKE_ISSUER_WIRE_TABLE,
  installFakeIssuerIfConfigured,
  resetFakeIssuer,
} from "../src/connected-providers/fake-issuer.js";

afterEach(() => resetFakeIssuer());

function codexProvider() {
  const entry = connectedProviders().find(({ id }) => id === "openai-codex");
  if (!entry) throw new Error("openai-codex is not a connected provider");
  return entry.provider();
}

describe("connected provider registry", () => {
  test("resolves user aliases and canonical provider ids", () => {
    expect(
      connectedProviders().map(({ id, label, alias, loginModes }) => ({
        id,
        label,
        alias,
        loginModes,
      })),
    ).toEqual([
      {
        id: "openai-codex",
        label: "ChatGPT",
        alias: "chatgpt",
        loginModes: ["device_code", "browser"],
      },
      {
        id: "github-copilot",
        label: "GitHub Copilot",
        alias: "copilot",
        loginModes: ["device_code"],
      },
    ]);
    expect(resolveConnectedProviderAlias("chatgpt")).toBe("openai-codex");
    expect(resolveConnectedProviderAlias("openai-codex")).toBe("openai-codex");
    expect(resolveConnectedProviderAlias("copilot")).toBe("github-copilot");
    expect(resolveConnectedProviderAlias("github-copilot")).toBe("github-copilot");
    expect(resolveConnectedProviderAlias("unknown")).toBeUndefined();
  });

  // The registry is the seam the rest of the agent reads a provider through,
  // so the fake has to be visible there — it used to be installed into a pi-ai
  // global that no longer exists.
  test("fake issuer installation is unset-safe and idempotent", () => {
    const realBaseUrl = codexProvider().baseUrl;
    expect(realBaseUrl).toBe("https://chatgpt.com/backend-api");
    expect(installFakeIssuerIfConfigured({})).toBe("skipped");
    expect(codexProvider().baseUrl).toBe(realBaseUrl);

    const env = { [FAKE_ISSUER_ENV]: "http://127.0.0.1:43210" };
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    const installed = codexProvider();
    expect(installed.baseUrl).toBe("http://127.0.0.1:43210");
    // Idempotent means the same instance, not merely an equal one: a rebuild
    // on every read would drop an in-flight login's state.
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    expect(codexProvider()).toBe(installed);

    resetFakeIssuer();
    expect(codexProvider().baseUrl).toBe(realBaseUrl);
  });

  test("exports the pinned fake-issuer request contract", () => {
    expect(
      Object.values(FAKE_ISSUER_WIRE_TABLE).map(({ method, path, request }) => ({
        method,
        path,
        request,
      })),
    ).toEqual([
      {
        method: "POST",
        path: "/device/code",
        request: { client_id: "duet-agent:openai-codex", scope: "openid profile email" },
      },
      {
        method: "POST",
        path: "/token",
        request: {
          device_code: "fixture-device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
      {
        method: "POST",
        path: "/token",
        request: {
          device_code: "fixture-device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      },
      {
        method: "POST",
        path: "/token",
        request: { refresh_token: "fixture-refresh-token", grant_type: "refresh_token" },
      },
    ]);
  });
});
