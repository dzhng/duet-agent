import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createConnectedTokenManager } from "../src/connected-providers/tokens.js";
import { refreshOpenAICodexCredentials } from "../src/connected-providers/refresh.js";
import {
  createConnectedProviderStore,
  type ConnectionRecord,
} from "../src/connected-providers/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempHome: string | undefined;

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe("connected provider token refresh", () => {
  testIfDocker(
    "two concurrent callers refresh an expired token once and both see the rotated credential",
    async () => {
      tempHome = await mkdtemp(join(tmpdir(), "duet-connected-refresh-"));
      const store = createConnectedProviderStore({ homeDir: tempHome });
      const expired: ConnectionRecord = {
        provider: "openai-codex",
        credentials: { access: "old-access", refresh: "old-refresh", expires: 900 },
        connectedAt: 100,
        eligibility: "eligible",
      };
      await store.withLock("openai-codex", async () => ({ next: expired, result: undefined }));

      let refreshes = 0;
      const manager = createConnectedTokenManager({
        store,
        now: () => 1_000,
        refreshCredentials: async () => {
          refreshes += 1;
          await Bun.sleep(20);
          return { access: "new-access", refresh: "rotated-refresh", expires: 100_000 };
        },
      });

      const tokens = await Promise.all([
        manager.ensureFreshToken("openai-codex"),
        manager.ensureFreshToken("openai-codex"),
      ]);

      expect(refreshes).toBe(1);
      expect(tokens).toEqual(["new-access", "new-access"]);
      expect(manager.apiKey("openai-codex")).toBe("new-access");
      expect((await store.get("openai-codex"))?.credentials).toEqual({
        access: "new-access",
        refresh: "rotated-refresh",
        expires: 100_000,
      });
    },
  );

  test("OpenAI Codex refresh sends the required scope and keeps the rotated token", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
      }),
    ).toString("base64url");
    let request: RequestInit | undefined;
    const credentials = await refreshOpenAICodexCredentials(
      `old-refresh`,
      async (_input, init) => {
        request = init;
        return new Response(
          JSON.stringify({
            access_token: `header.${payload}.signature`,
            refresh_token: "rotated-refresh",
            expires_in: 600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      () => 1_000,
    );

    const body = new URLSearchParams(String(request?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      scope: "openid profile email",
    });
    expect(credentials).toEqual({
      access: `header.${payload}.signature`,
      refresh: "rotated-refresh",
      expires: 601_000,
      accountId: "account-1",
    });
  });
});
