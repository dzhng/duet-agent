import { afterEach, describe, expect, test } from "bun:test";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import {
  connectedProviders,
  resolveConnectedProviderAlias,
} from "../src/connected-providers/registry.js";
import {
  FAKE_ISSUER_ENV,
  FAKE_ISSUER_WIRE_TABLE,
  installFakeIssuerIfConfigured,
} from "../src/connected-providers/fake-issuer.js";

afterEach(() => resetOAuthProviders());

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

  test("fake issuer installation is unset-safe and idempotent", () => {
    const builtIn = getOAuthProvider("openai-codex");
    expect(installFakeIssuerIfConfigured({})).toBe("skipped");
    expect(getOAuthProvider("openai-codex")).toBe(builtIn);

    const env = { [FAKE_ISSUER_ENV]: "http://127.0.0.1:43210" };
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    const installed = getOAuthProvider("openai-codex");
    expect(installed).not.toBe(builtIn);
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    expect(getOAuthProvider("openai-codex")).toBe(installed);
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
