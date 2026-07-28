import { afterEach, describe, expect, test } from "bun:test";

import { activeDuetTier, setActiveDuetTier } from "../src/model-routing/active-tier.js";
import { DUET_TIER_HEADER, resolveDuetGatewayModel } from "../src/model-resolution/duet-gateway.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";

afterEach(() => setActiveDuetTier(undefined));

describe("duet gateway tier attribution", () => {
  test("stamps the active tier on every duet-gateway model", () => {
    setActiveDuetTier("balanced");

    // One assertion per routing role the product bills: the parent step, the
    // classifier, the advisor and the vision fallback all resolve through this
    // seam, so a per-role regression shows up here rather than in production.
    for (const modelId of [
      "anthropic/claude-fable-5",
      "openai/gpt-5.6-luna",
      "moonshotai/kimi-k3",
      "zai/glm-5.2",
    ]) {
      expect(resolveDuetGatewayModel(modelId).headers?.[DUET_TIER_HEADER]).toBe("balanced");
    }
  });

  test("omits the header entirely when a concrete model is pinned", () => {
    setActiveDuetTier(undefined);

    const model = resolveDuetGatewayModel("anthropic/claude-fable-5");

    expect(model.headers?.[DUET_TIER_HEADER]).toBeUndefined();
  });

  test("carries whatever tier name the routing table defines", () => {
    // Tier names come from a config-driven table, so the agent must attribute
    // a name it has never heard of rather than validating against a fixed set.
    setActiveDuetTier("some-operator-defined-tier");

    expect(resolveDuetGatewayModel("openai/gpt-5.6-sol").headers?.[DUET_TIER_HEADER]).toBe(
      "some-operator-defined-tier",
    );
  });

  test("preserves headers the upstream model already carries", () => {
    setActiveDuetTier("frontier");

    const model = resolveDuetGatewayModel("anthropic/claude-fable-5");

    expect(model.headers?.[DUET_TIER_HEADER]).toBe("frontier");
    expect(model.provider).toBe("duet-gateway");
  });

  test("leaves non-gateway transports unattributed", () => {
    setActiveDuetTier("frontier");

    // A vercel/openrouter pin is not Duet-metered traffic, so it must not claim
    // a Duet tier even while a routed session is active.
    expect(resolveModelName("vercel-ai-gateway:zai/glm-5.2").headers?.[DUET_TIER_HEADER]).toBe(
      undefined,
    );
  });

  test("reports the active tier back to callers", () => {
    setActiveDuetTier("economy");
    expect(activeDuetTier()).toBe("economy");

    setActiveDuetTier(undefined);
    expect(activeDuetTier()).toBeUndefined();
  });
});
