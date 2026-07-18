import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchModelCatalog,
  createDuetModelGateway,
} from "../src/model-resolution/model-gateway.js";
import {
  getDuetGatewayBaseUrl,
  resolveDuetGatewayModel,
} from "../src/model-resolution/duet-gateway.js";

const ENV_KEYS = ["DUET_GATEWAY_BASE_URL", "DUET_API_KEY"] as const;

const originalEnv = new Map<string, string | undefined>();
let originalFetch: typeof fetch;

for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getDuetGatewayBaseUrl", () => {
  test("uses DUET_GATEWAY_BASE_URL verbatim after trimming and stripping a trailing slash", () => {
    process.env.DUET_GATEWAY_BASE_URL = "  https://gateway.example.com/custom/  ";

    expect(getDuetGatewayBaseUrl()).toBe("https://gateway.example.com/custom");
  });

  test("falls back to gateway.duet.so when unset", () => {
    expect(getDuetGatewayBaseUrl()).toBe("https://gateway.duet.so");
  });
});

describe("duet-gateway model routing", () => {
  test("uses the dedicated base directly for anthropic transport models", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base";

    const model = resolveDuetGatewayModel("anthropic/claude-opus-4.8");

    expect(model.baseUrl).toBe("https://gateway.example.com/base");
  });

  test("appends /v1 to the dedicated base for OpenAI transport models", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base";

    const model = resolveDuetGatewayModel("openai/gpt-5.5");

    expect(model.baseUrl).toBe("https://gateway.example.com/base/v1");
  });
});

describe("duet model gateway routing", () => {
  test("fetches the model catalog from the dedicated base /v1/models path", async () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base";
    process.env.DUET_API_KEY = "duet_gt_test";
    const calls: { url: string; authorization: string | undefined }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url:
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.5", type: "language" }] }));
    }) as typeof fetch;

    const catalog = await fetchModelCatalog();

    expect(calls).toEqual([
      {
        url: "https://gateway.example.com/base/v1/models",
        authorization: "Bearer duet_gt_test",
      },
    ]);
    expect(catalog.get("openai/gpt-5.5")).toBe("language");
  });

  test("builds the AI SDK gateway on the dedicated base /v4/ai path", async () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base/";
    process.env.DUET_API_KEY = "duet_gt_test";
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      return new Response(JSON.stringify({ models: [] }));
    }) as typeof fetch;

    const gateway = createDuetModelGateway();
    await gateway.getAvailableModels();

    expect(calls).toEqual(["https://gateway.example.com/base/v4/ai/config"]);
  });
});
