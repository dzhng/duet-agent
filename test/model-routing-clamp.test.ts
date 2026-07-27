import { afterEach, describe, expect, test } from "bun:test";
import { setActiveDuetTierFromModelSelection } from "../src/model-routing/active-tier.js";
import { resolveRoute } from "../src/model-routing/resolve.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { transportModelId } from "../src/model-resolution/catalog.js";
import { resolveDuetGatewayModel } from "../src/model-resolution/duet-gateway.js";
import { routingCatalogAdapter } from "../src/model-resolution/resolver.js";

afterEach(() => {
  setActiveDuetTierFromModelSelection(undefined);
});

describe("duet-gateway routing override clamp", () => {
  test("rejects an override target outside the active built-in tier closure", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes.implement.target.modelName = "sol";
    const target = resolveRoute(
      table,
      "economy",
      "implement",
      { hasImages: false },
      routingCatalogAdapter,
    );
    const gatewayModelId = transportModelId("duet-gateway", target.modelName);
    if (!gatewayModelId) throw new Error("test target needs a duet-gateway id");

    setActiveDuetTierFromModelSelection("economy");

    expect(() => resolveDuetGatewayModel(gatewayModelId)).toThrow(
      /openai\/gpt-5\.6-sol.*outside.*economy/i,
    );
  });

  test("allows narrowing and reordering when every target remains in closure", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes = {
      general: table.tiers.economy.routes.general,
      implement: {
        ...table.tiers.economy.routes.implement,
        target: { modelName: "luna", thinkingLevel: "low" },
      },
    };
    const target = resolveRoute(
      table,
      "economy",
      "implement",
      { hasImages: false },
      routingCatalogAdapter,
    );
    const gatewayModelId = transportModelId("duet-gateway", target.modelName);
    if (!gatewayModelId) throw new Error("test target needs a duet-gateway id");

    setActiveDuetTierFromModelSelection("economy");

    expect(resolveDuetGatewayModel(gatewayModelId)).toMatchObject({
      id: "openai/gpt-5.6-luna",
      headers: { "x-duet-tier": "economy" },
    });
  });

  test("does not clamp concrete pins or non-duet-gateway transports", () => {
    setActiveDuetTierFromModelSelection("duet:openai/gpt-5.6-sol");
    expect(() => resolveDuetGatewayModel("openai/gpt-5.6-sol")).not.toThrow();

    setActiveDuetTierFromModelSelection("economy");
    expect(() =>
      routingCatalogAdapter.modelAcceptsImages("vercel-ai-gateway:openai/gpt-5.6-sol"),
    ).not.toThrow();
  });
});
