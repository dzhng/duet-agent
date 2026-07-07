import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "bun:test";
import { testIfDocker } from "./helpers/docker-only.js";

let tempRoot: string | undefined;
let originalFetch: typeof fetch;
let originalApiBaseUrl: string | undefined;
let originalAppBaseUrl: string | undefined;
let originalWorkspace: string | undefined;
let originalApiKey: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalApiBaseUrl = process.env.DUET_API_BASE_URL;
  originalAppBaseUrl = process.env.DUET_APP_BASE_URL;
  originalWorkspace = process.env.DUET_WORKSPACE;
  originalApiKey = process.env.DUET_API_KEY;
  process.env.DUET_API_BASE_URL = "https://api.test";
  process.env.DUET_APP_BASE_URL = "https://app.test";
  process.env.DUET_WORKSPACE = "acme";
  delete process.env.DUET_API_KEY;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalApiBaseUrl === undefined) delete process.env.DUET_API_BASE_URL;
  else process.env.DUET_API_BASE_URL = originalApiBaseUrl;
  if (originalAppBaseUrl === undefined) delete process.env.DUET_APP_BASE_URL;
  else process.env.DUET_APP_BASE_URL = originalAppBaseUrl;
  if (originalWorkspace === undefined) delete process.env.DUET_WORKSPACE;
  else process.env.DUET_WORKSPACE = originalWorkspace;
  if (originalApiKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = originalApiKey;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("duet login", () => {
  testIfDocker("posts a cli_login analytics event after a successful login", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const envFile = join(root, ".env");

    const calls: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url.endsWith("/v1/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device-123",
            user_code: "ABCD-EFGH",
            verification_uri: "https://duet.so/device",
            expires_in: 600,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/device/token")) {
        return new Response(
          JSON.stringify({
            status: "approved",
            access_token: "duet_gt_test",
            workspace: { slug: "acme", name: "Acme" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { runLoginCommand } = await import("../src/cli/login.js");
    await runLoginCommand(["--no-browser", "--skip-skill-sync"], { envFilePath: envFile });

    const analyticsCall = calls.find((c) =>
      c.url.startsWith("https://app.test/api/v1/analytics/events"),
    );
    expect(analyticsCall).toBeDefined();
    expect(analyticsCall!.method).toBe("POST");
    expect(JSON.parse(analyticsCall!.body)).toEqual({ name: "cli_login" });
  });
});
