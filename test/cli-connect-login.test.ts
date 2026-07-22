import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  registerOAuthProvider,
  resetOAuthProviders,
  type OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/oauth";
import { runConnectCommand } from "../src/cli/connect.js";
import { FAKE_ISSUER_ENV } from "../src/connected-providers/fake-issuer.js";
import type { ConnectedProviderStore, ConnectionRecord } from "../src/connected-providers/store.js";
import { createConnectedProviderStore } from "../src/connected-providers/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

const SECRET_ACCESS = "connect-access-must-never-appear";
const SECRET_REFRESH = "connect-refresh-must-never-appear";

afterEach(() => resetOAuthProviders());

describe("duet connect login", () => {
  test("ChatGPT defaults by TTY while Copilot remains device-code", async () => {
    const selectedModes: string[] = [];
    const opened: string[] = [];
    registerLoginFixture("openai-codex", async (callbacks) => {
      const selected = await callbacks.onSelect({ message: "mode", options: [] });
      selectedModes.push(selected ?? "cancelled");
      if (selected === "device_code") {
        callbacks.onDeviceCode({
          userCode: "CHAT-GPT1",
          verificationUri: "https://verify.test/chatgpt",
          expiresInSeconds: 600,
        });
      } else {
        callbacks.onAuth({ url: "https://browser.test/authorize" });
      }
    });
    registerLoginFixture("github-copilot", async (callbacks) => {
      callbacks.onDeviceCode({
        userCode: "COPI-LOT1",
        verificationUri: "https://verify.test/copilot",
        expiresInSeconds: 600,
      });
    });
    const records: ConnectionRecord[] = [];
    let stdout = "";
    let stderr = "";
    const io = {
      store: memoryStore(records),
      interactive: true,
      openUrl: (url: string) => opened.push(url),
      write: (text: string) => {
        stdout += text;
      },
      writeError: (text: string) => {
        stderr += text;
      },
      probe: async () => ({ eligibility: "eligible" as const, servedModelIds: [] }),
    };

    await runConnectCommand(["chatgpt"], io);
    await runConnectCommand(["chatgpt"], { ...io, interactive: false, openUrl: () => {} });
    await runConnectCommand(["copilot", "--no-browser"], io);

    expect(selectedModes).toEqual(["browser", "device_code"]);
    expect(opened).toEqual(["https://browser.test/authorize"]);
    expect(records.map(({ provider }) => provider)).toEqual(["openai-codex", "github-copilot"]);
    expect(stdout).toBe("Connected ChatGPT.\nConnected ChatGPT.\nConnected GitHub Copilot.\n");
    expect(stderr).toContain("User code: CHAT-GPT1");
    expect(stderr).toContain("User code: COPI-LOT1");
    expect(`${stdout}\n${stderr}`).not.toContain(SECRET_ACCESS);
    expect(`${stdout}\n${stderr}`).not.toContain(SECRET_REFRESH);
  });

  testIfDocker(
    "device-code NDJSON runs through the fake issuer and persists the probed record",
    async () => {
      const requests: Array<{ path: string; body: unknown }> = [];
      let tokenPolls = 0;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const body = await request.json();
          requests.push({ path: url.pathname, body });
          if (url.pathname === "/device/code") {
            return Response.json({
              device_code: "device-secret",
              user_code: "ABCD-EFGH",
              verification_uri: "https://verify.test/device",
              interval: 0,
              expires_in: 60,
            });
          }
          if (url.pathname === "/token" && tokenPolls++ === 0) {
            return Response.json({ status: "pending" });
          }
          return Response.json({
            access_token: SECRET_ACCESS,
            refresh_token: SECRET_REFRESH,
            expires_in: 3600,
            account_id: "account-secret",
          });
        },
      });
      const homeDir = await mkdtemp(join(tmpdir(), "duet-connect-login-"));
      const store = createConnectedProviderStore({ homeDir });
      let stdout = "";
      let stderr = "";
      let persisted: ConnectionRecord[] = [];

      try {
        await runConnectCommand(["chatgpt", "--device-code", "--no-browser", "--json"], {
          store,
          env: { [FAKE_ISSUER_ENV]: server.url.toString() },
          write: (text) => {
            stdout += text;
          },
          writeError: (text) => {
            stderr += text;
          },
          probe: async () => ({
            eligibility: "eligible",
            servedModelIds: ["gpt-5.6-luna"],
          }),
          now: () => 1_700_000_000_000,
        });
        persisted = await store.read();
      } finally {
        server.stop(true);
        await rm(homeDir, { recursive: true, force: true });
      }

      expect(requests.map(({ path }) => path)).toEqual(["/device/code", "/token", "/token"]);
      expect(requests.map(({ body }) => body)).toEqual([
        {
          client_id: "duet-agent:openai-codex",
          scope: "openid profile email",
        },
        {
          device_code: "device-secret",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        {
          device_code: "device-secret",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      ]);
      expect(persisted).toEqual([
        {
          provider: "openai-codex",
          credentials: {
            access: SECRET_ACCESS,
            refresh: SECRET_REFRESH,
            expires: expect.any(Number),
            accountId: "account-secret",
          },
          connectedAt: 1_700_000_000_000,
          eligibility: "eligible",
          eligibilityCheckedAt: 1_700_000_000_000,
        },
      ]);
      expect(
        stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          type: "device_code",
          provider: "openai-codex",
          verificationUri: "https://verify.test/device",
          userCode: "ABCD-EFGH",
          expiresAt: 1_700_000_060_000,
        },
        { type: "progress", provider: "openai-codex", code: "probing_capability" },
        { type: "complete", provider: "openai-codex", state: "connected" },
      ]);
      expect(`${stdout}\n${stderr}`).not.toContain(SECRET_ACCESS);
      expect(`${stdout}\n${stderr}`).not.toContain(SECRET_REFRESH);
      expect(`${stdout}\n${stderr}`).not.toContain("account-secret");
      // Machine mode owns stdout exclusively; the parsed-event assertion above
      // pins the protocol content without snapshot-serializer formatting.
      expect(stderr).toBe("");
    },
  );

  testIfDocker(
    "denied and expired device codes exit non-zero with secret-free protocol errors",
    async () => {
      for (const scenario of [
        { status: "denied", code: "login_denied" },
        { status: "expired", code: "login_expired" },
      ] as const) {
        const server = Bun.serve({
          port: 0,
          async fetch(request) {
            const path = new URL(request.url).pathname;
            await request.json();
            if (path === "/device/code") {
              return Response.json({
                device_code: "device-secret",
                user_code: "ABCD-EFGH",
                verification_uri: "https://verify.test/device",
                interval: 0,
                expires_in: 60,
              });
            }
            return Response.json({ status: scenario.status, access_token: SECRET_ACCESS });
          },
        });
        try {
          const processResult = Bun.spawn(
            ["bun", "src/cli.ts", "connect", "chatgpt", "--device-code", "--json"],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                [FAKE_ISSUER_ENV]: server.url.toString(),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(processResult.stdout).text(),
            new Response(processResult.stderr).text(),
            processResult.exited,
          ]);
          const events = stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

          expect(exitCode).not.toBe(0);
          expect(events.map(({ type }) => type)).toEqual(["device_code", "error"]);
          expect(events[1]).toEqual({
            type: "error",
            provider: "openai-codex",
            code: scenario.code,
          });
          expect(`${stdout}\n${stderr}`).not.toContain(SECRET_ACCESS);
          expect(`${stdout}\n${stderr}`).not.toContain(SECRET_REFRESH);
          expect(`${stdout}\n${stderr}`).not.toContain("device-secret");
        } finally {
          server.stop(true);
        }
      }
    },
  );
});

function memoryStore(records: ConnectionRecord[]): ConnectedProviderStore {
  return {
    async read() {
      return records;
    },
    async get(id) {
      return records.find((record) => record.provider === id);
    },
    async remove(id) {
      const index = records.findIndex((record) => record.provider === id);
      if (index >= 0) records.splice(index, 1);
    },
    async withLock(id, mutate) {
      const current = records.find((record) => record.provider === id);
      const { next, result } = await mutate(current);
      const index = records.findIndex((record) => record.provider === id);
      if (index >= 0) records.splice(index, 1);
      if (next) records.push(next);
      return result;
    },
  };
}

function registerLoginFixture(
  id: "openai-codex" | "github-copilot",
  announce: (callbacks: OAuthLoginCallbacks) => Promise<void>,
): void {
  registerOAuthProvider({
    id,
    name: id,
    async login(callbacks) {
      await announce(callbacks);
      return {
        access: SECRET_ACCESS,
        refresh: SECRET_REFRESH,
        expires: 2_000_000_000_000,
      };
    },
    async refreshToken(credentials) {
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  });
}
