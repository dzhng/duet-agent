import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchModelCatalog,
  createDuetModelGateway,
} from "../src/model-resolution/model-gateway.js";
import { getDuetGatewayBaseUrl } from "../src/model-resolution/duet-gateway.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";

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
  test("maps GLM xhigh to the gateway's maximum reasoning effort", () => {
    const model = resolveModelName("duet-gateway:zai/glm-5.2");

    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(model.thinkingLevelMap?.xhigh).toBe("max");
  });

  test("uses the dedicated base directly for anthropic transport models", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base";

    const model = resolveModelName("duet-gateway:anthropic/claude-opus-4.8");

    expect(model.baseUrl).toBe("https://gateway.example.com/base");
  });

  test("appends /v1 to the dedicated base for OpenAI transport models", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://gateway.example.com/base";

    const model = resolveModelName("duet-gateway:openai/gpt-5.6-sol");

    expect(model.baseUrl).toBe("https://gateway.example.com/base/v1");
  });
});

// Fable 5.1 is the advisor's model and pi-ai has not shipped it, so every
// router resolves it through a cloned sibling. These are Anthropic's published
// numbers; a synthesized pass-through would bill it as free and text-only.
describe("models the catalog has not shipped", () => {
  test("resolves Fable 5.1 on its published contract on every router", () => {
    for (const provider of ["duet-gateway", "vercel-ai-gateway", "openrouter"] as const) {
      const model = resolveModelName(`${provider}:anthropic/claude-fable-5.1`);

      expect(model.cost, provider).toEqual({
        input: 10,
        output: 50,
        cacheRead: 0.25,
        cacheWrite: 12.5,
      });
      expect(model.input, provider).toContain("image");
      expect(model.contextWindow, provider).toBe(1_000_000);
      expect(model.maxTokens, provider).toBe(128_000);
    }
  });

  test("still falls back to a conservative pass-through for a genuinely unknown id", () => {
    const model = resolveModelName("duet-gateway:anthropic/claude-not-a-model");

    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(256_000);
    expect(model.maxTokens).toBe(64_000);
  });
});

// The transport and route are ours to pin; the prices are the vendor's, so
// this asserts only that a real one survived resolution — a model missing
// from the catalog resolves to a zeroed pass-through, and cost accounting
// would then lie rather than fail.
describe("connected-provider models", () => {
  test("resolves the codex 5.6 models on their native transport, priced", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const model = resolveModelName(`openai-codex:${id}`);

      expect(model).toMatchObject({
        id,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      });
      expect(model.cost.input, `${id} resolved to a free model`).toBeGreaterThan(0);
      expect(model.cost.output, `${id} resolved to a free model`).toBeGreaterThan(0);
    }
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
      return new Response(
        JSON.stringify({ data: [{ id: "openai/gpt-5.6-sol", type: "language" }] }),
      );
    }) as typeof fetch;

    const catalog = await fetchModelCatalog();

    expect(calls).toEqual([
      {
        url: "https://gateway.example.com/base/v1/models",
        authorization: "Bearer duet_gt_test",
      },
    ]);
    expect(catalog.get("openai/gpt-5.6-sol")).toBe("language");
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
