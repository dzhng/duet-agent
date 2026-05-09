import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock } from "bun:test";
import { testIfDocker } from "./helpers/docker-only.js";

mock.module("../src/lib/login.js", () => ({
  loginWithBrowser: async () => ({
    apiKey: "duet_gt_test",
    orgSlug: "acme",
    orgName: "Acme",
  }),
}));

let tempRoot: string | undefined;
let originalFetch: typeof fetch;
let originalBaseUrl: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalBaseUrl = process.env.DUET_APP_BASE_URL;
  process.env.DUET_APP_BASE_URL = "https://test";
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.DUET_APP_BASE_URL;
  else process.env.DUET_APP_BASE_URL = originalBaseUrl;
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
      calls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { runLoginCommand } = await import("../src/cli/login.js");
    await runLoginCommand(["--skip-skill-sync"], { envFilePath: envFile });

    const analyticsCall = calls.find((c) =>
      c.url.startsWith("https://test/api/v1/analytics/events"),
    );
    expect(analyticsCall).toBeDefined();
    expect(analyticsCall!.method).toBe("POST");
    expect(JSON.parse(analyticsCall!.body)).toEqual({ name: "cli_login" });
  });
});
