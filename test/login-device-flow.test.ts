import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginWithDeviceFlow } from "../src/lib/login.js";
import { runLoginCommand } from "../src/cli/login.js";
import { testIfDocker } from "./helpers/docker-only.js";

interface RecordedRequest {
  url: string;
  body: unknown;
}

const EXPECTED_LOGIN_BODY = {
  capabilities: ["files:read", "files:write", "memory", "sessions", "services", "integrations"],
};

let originalApiBaseUrl: string | undefined;
let originalApiKey: string | undefined;
let originalFetch: typeof fetch;
let tempRoot: string | undefined;

beforeEach(() => {
  originalApiBaseUrl = process.env.DUET_API_BASE_URL;
  originalApiKey = process.env.DUET_API_KEY;
  originalFetch = globalThis.fetch;
  delete process.env.DUET_API_BASE_URL;
  delete process.env.DUET_API_KEY;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalApiBaseUrl === undefined) delete process.env.DUET_API_BASE_URL;
  else process.env.DUET_API_BASE_URL = originalApiBaseUrl;
  if (originalApiKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = originalApiKey;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("loginWithDeviceFlow", () => {
  test("requests login capabilities and polls pending to approved", async () => {
    const requests: RecordedRequest[] = [];
    const logs: string[] = [];
    const fetchFn = makeDeviceFetch(requests, [
      codeResponse(),
      tokenResponse({ status: "pending" }),
      tokenResponse({
        status: "approved",
        access_token: "duet_gt_approved",
        workspace: { slug: "acme", name: "Acme Inc" },
      }),
    ]);

    const result = await loginWithDeviceFlow({
      apiBaseUrl: "https://api.test",
      noBrowser: true,
      fetchFn,
      sleep: async () => {},
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({
      apiKey: "duet_gt_approved",
      workspaceSlug: "acme",
      workspaceName: "Acme Inc",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.test/v1/device/code",
      "https://api.test/v1/device/token",
      "https://api.test/v1/device/token",
    ]);
    expect(requests[0]!.body).toEqual(EXPECTED_LOGIN_BODY);
    expect(requests[1]!.body).toEqual({ device_code: "device-123" });
    expect(logs).toContain("User code: ABCD-EFGH");
    expect(logs).toContain("Verification URL: https://duet.so/device");
  });

  test("opens the verification URI unless disabled", async () => {
    const opened: string[] = [];
    const fetchFn = makeDeviceFetch(
      [],
      [
        codeResponse(),
        tokenResponse({
          status: "approved",
          access_token: "duet_gt_approved",
          workspace: { slug: "acme", name: "Acme Inc" },
        }),
      ],
    );

    await loginWithDeviceFlow({
      apiBaseUrl: "https://api.test",
      fetchFn,
      sleep: async () => {},
      openUrl: (url) => opened.push(url),
      log: () => {},
    });

    expect(opened).toEqual(["https://duet.so/device"]);
  });

  test("throws when the device flow is denied", async () => {
    const fetchFn = makeDeviceFetch([], [codeResponse(), tokenResponse({ status: "denied" })]);

    await expect(
      loginWithDeviceFlow({
        apiBaseUrl: "https://api.test",
        noBrowser: true,
        fetchFn,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow("Device login denied.");
  });

  test("throws when the device code expires", async () => {
    const fetchFn = makeDeviceFetch([], [codeResponse(), tokenResponse({ status: "expired" })]);

    await expect(
      loginWithDeviceFlow({
        apiBaseUrl: "https://api.test",
        noBrowser: true,
        fetchFn,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow("Device login expired");
  });
});

describe("duet login device flow command", () => {
  testIfDocker("persists the approved DUET_API_KEY for the server-selected workspace", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-device-login-")));
    const envFile = join(root, ".env");
    process.env.DUET_API_BASE_URL = "https://api.test";
    const requests: RecordedRequest[] = [];
    globalThis.fetch = makeDeviceFetch(requests, [
      codeResponse(),
      tokenResponse({
        status: "approved",
        access_token: "duet_gt_cli",
        workspace: { slug: "acme", name: "Acme Inc" },
      }),
    ]);

    await runLoginCommand(["--no-browser"], {
      envFilePath: envFile,
    });

    expect(await readFile(envFile, "utf8")).toBe("DUET_API_KEY=duet_gt_cli\n");
    expect(requests[0]!.body).toEqual(EXPECTED_LOGIN_BODY);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.test/v1/device/code",
      "https://api.test/v1/device/token",
    ]);
  });

  testIfDocker("does not persist an approved token without a workspace", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-device-login-")));
    const envFile = join(root, ".env");
    process.env.DUET_API_BASE_URL = "https://api.test";
    globalThis.fetch = makeDeviceFetch(
      [],
      [codeResponse(), tokenResponse({ status: "approved", access_token: "duet_gt_malformed" })],
    );

    await expect(
      runLoginCommand(["--no-browser"], {
        envFilePath: envFile,
      }),
    ).rejects.toThrow("Device token response was malformed.");
    await expect(readFile(envFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  testIfDocker("does not persist an approved token with a partial workspace", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-device-login-")));
    process.env.DUET_API_BASE_URL = "https://api.test";

    for (const [index, workspace] of [{ slug: "acme" }, { name: "Acme Inc" }].entries()) {
      const envFile = join(root, `.env-${index}`);
      globalThis.fetch = makeDeviceFetch(
        [],
        [
          codeResponse(),
          tokenResponse({
            status: "approved",
            access_token: "duet_gt_partial",
            workspace,
          }),
        ],
      );

      await expect(
        runLoginCommand(["--no-browser"], {
          envFilePath: envFile,
        }),
      ).rejects.toThrow("Device token response was malformed.");
      await expect(readFile(envFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

function makeDeviceFetch(requests: RecordedRequest[], responses: Response[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch");
    return response;
  }) as unknown as typeof fetch;
}

function codeResponse(): Response {
  return jsonResponse({
    device_code: "device-123",
    user_code: "ABCD-EFGH",
    verification_uri: "https://duet.so/device",
    expires_in: 600,
    interval: 1,
  });
}

function tokenResponse(body: Record<string, unknown>): Response {
  return jsonResponse(body);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
