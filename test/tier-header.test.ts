import { afterEach, describe, expect, test } from "bun:test";
import { createEmbeddingClient } from "../src/memory/embedding.js";
import {
  activeDuetTier,
  setActiveDuetTierFromModelSelection,
} from "../src/model-routing/active-tier.js";
import { resolveDuetGatewayModel } from "../src/model-resolution/duet-gateway.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";
import type { DuetModelTier } from "../src/routing-manifest.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";

afterEach(() => {
  setActiveDuetTierFromModelSelection(undefined);
});

const callSites: Record<DuetModelTier, ReadonlyArray<[string, string]>> = {
  frontier: [
    ["actor", "openai/gpt-5.6-sol"],
    ["classifier", "openai/gpt-5.6-luna"],
    ["advisor", "anthropic/claude-fable-5"],
    ["vision-fallback", "moonshotai/kimi-k3"],
    ["subagent", "openai/gpt-5.6-sol"],
    ["memory", "openai/gpt-5.6-luna"],
  ],
  balanced: [
    ["actor", "openai/gpt-5.6-terra"],
    ["classifier", "openai/gpt-5.6-luna"],
    ["advisor", "anthropic/claude-fable-5"],
    ["vision-fallback", "moonshotai/kimi-k3"],
    ["subagent", "openai/gpt-5.6-sol"],
    ["memory", "openai/gpt-5.6-luna"],
  ],
  economy: [
    ["actor", "openai/gpt-5.6-luna"],
    ["classifier", "openai/gpt-5.6-luna"],
    ["vision-fallback", "openai/gpt-5.6-luna"],
    ["subagent", "zai/glm-5.2"],
    ["memory", "openai/gpt-5.6-luna"],
  ],
};

describe("x-duet-tier model headers", () => {
  test("covers every routed duet-gateway call site and never leaks from a concrete pin", () => {
    for (const [tier, sites] of Object.entries(callSites) as Array<
      [DuetModelTier, ReadonlyArray<[string, string]>]
    >) {
      setActiveDuetTierFromModelSelection(tier);
      expect(activeDuetTier(), tier).toBe(tier);
      for (const [site, modelId] of sites) {
        expect(resolveDuetGatewayModel(modelId).headers?.["x-duet-tier"], `${tier} ${site}`).toBe(
          tier,
        );
      }

      setActiveDuetTierFromModelSelection("duet:anthropic/claude-opus-5");
      expect(activeDuetTier(), `${tier} concrete pin`).toBeUndefined();
      for (const [site, modelId] of sites) {
        expect(
          resolveDuetGatewayModel(modelId).headers?.["x-duet-tier"],
          `pin after ${tier} ${site}`,
        ).toBeUndefined();
      }
    }
  });

  test("does not stamp non-duet-gateway transports", () => {
    setActiveDuetTierFromModelSelection("frontier");

    expect(
      resolveModelName("vercel-ai-gateway:openai/gpt-5.6-sol").headers?.["x-duet-tier"],
    ).toBeUndefined();
    expect(
      resolveModelName("openrouter:openai/gpt-5.6-sol").headers?.["x-duet-tier"],
    ).toBeUndefined();
  });

  test("stamps embeddings only while a routed tier is active", async () => {
    const captured: Array<Headers> = [];
    const embed = createEmbeddingClient({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            data: [{ embedding: [1] }],
            model: "google/gemini-embedding-2",
          }),
        );
      }) as typeof fetch,
    });

    setActiveDuetTierFromModelSelection("economy");
    await embed(["routed"]);
    setActiveDuetTierFromModelSelection("duet:openai/gpt-5.6-luna");
    await embed(["pinned"]);

    expect(captured.map((headers) => headers.get("x-duet-tier"))).toEqual(["economy", null]);
  });

  test("boot and tier flips retarget actor and auxiliary gateway calls together", async () => {
    const previousKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "tier-flip-test-key";
    const runner = new TurnRunner({
      model: "economy",
      mode: "agent",
      memoryDbPath: false,
      memoryStores: false,
      skillDiscovery: { includeDefaults: false },
    });

    try {
      await runner.start({ type: "start", mode: "agent" });
      expect(activeDuetTier()).toBe("economy");
      expect(runner.routeStatus()?.modelName).toBe("luna");
      expect(
        resolveDuetGatewayModel("openai/gpt-5.6-luna").headers?.["x-duet-tier"],
        "classifier before flip",
      ).toBe("economy");

      expect(runner.setModel("frontier")).toEqual({ routed: true });
      expect(activeDuetTier()).toBe("frontier");
      expect(runner.getState()?.options?.model).toBe("frontier");
      expect(
        resolveDuetGatewayModel("anthropic/claude-fable-5").headers?.["x-duet-tier"],
        "advisor after flip",
      ).toBe("frontier");
      expect(
        resolveDuetGatewayModel("openai/gpt-5.6-luna").headers?.["x-duet-tier"],
        "memory after flip",
      ).toBe("frontier");

      runner.setModel("duet:anthropic/claude-opus-5");
      expect(activeDuetTier()).toBeUndefined();
      expect(
        resolveDuetGatewayModel("openai/gpt-5.6-luna").headers?.["x-duet-tier"],
        "memory after concrete pin",
      ).toBeUndefined();
    } finally {
      await runner.dispose();
      if (previousKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = previousKey;
    }
  });
});
