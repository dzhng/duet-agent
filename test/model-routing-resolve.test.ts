import { describe, expect, test } from "bun:test";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { resolveRoute, resolveTierDefault } from "../src/model-routing/resolve.js";

const catalog = {
  modelAcceptsImages: (name: string) => name !== "glm",
};

describe("model route resolution", () => {
  test("falls through economy writing to its low-effort general route", () => {
    expect(
      resolveRoute(BUILT_IN_ROUTING_TABLE, "economy", "writing", { hasImages: false }, catalog),
    ).toEqual({
      tier: "economy",
      route: "general",
      modelName: "luna",
      thinkingLevel: "low",
      visionFallback: false,
      chain: ["economy"],
    });
  });

  test("applies economy implement's luna fallback without changing its route or effort", () => {
    expect(
      resolveRoute(BUILT_IN_ROUTING_TABLE, "economy", "implement", { hasImages: true }, catalog),
    ).toEqual({
      tier: "economy",
      route: "implement",
      modelName: "luna",
      thinkingLevel: "medium",
      visionFallback: true,
      chain: ["economy"],
    });
  });

  test("keeps a text-only target when its route has no vision fallback", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    delete table.tiers.economy.routes.implement.visionFallbackModelName;

    expect(resolveRoute(table, "economy", "implement", { hasImages: true }, catalog)).toEqual({
      tier: "economy",
      route: "implement",
      modelName: "glm",
      thinkingLevel: "medium",
      visionFallback: false,
      chain: ["economy"],
    });
  });

  test("re-enters a virtual fallback chain while preserving the selected route effort", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes.implement.visionFallbackModelName = "frontier";

    expect(resolveRoute(table, "economy", "implement", { hasImages: true }, catalog)).toEqual({
      tier: "frontier",
      route: "implement",
      modelName: "sol",
      thinkingLevel: "medium",
      visionFallback: true,
      chain: ["economy", "frontier"],
    });
  });

  test("re-enters the same route when a target names another virtual model", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.frontier.routes.implement.target.modelName = "balanced";
    table.tiers.balanced.routes.implement.target.modelName = "economy";

    expect(resolveRoute(table, "frontier", "implement", { hasImages: false }, catalog)).toEqual({
      tier: "economy",
      route: "implement",
      modelName: "glm",
      thinkingLevel: "medium",
      visionFallback: false,
      chain: ["frontier", "balanced", "economy"],
    });
  });

  test("throws with the complete path when virtual re-entry cycles", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.frontier.routes.general.target.modelName = "balanced";
    table.tiers.balanced.routes.general.target.modelName = "frontier";

    expect(() => resolveRoute(table, "frontier", "general", { hasImages: false }, catalog)).toThrow(
      "Virtual model cycle: frontier -> balanced -> frontier",
    );
  });

  test("resolves a selected tier's general route before classification", () => {
    expect(
      resolveTierDefault(BUILT_IN_ROUTING_TABLE, "balanced", { hasImages: false }, catalog),
    ).toEqual({
      tier: "balanced",
      route: "general",
      modelName: "terra",
      thinkingLevel: "medium",
      visionFallback: false,
      chain: ["balanced"],
    });
  });

  test("rejects an unknown tier instead of treating it as a concrete model", () => {
    expect(() =>
      resolveRoute(BUILT_IN_ROUTING_TABLE, "missing", "general", { hasImages: false }, catalog),
    ).toThrow('Unknown virtual model tier "missing"');
  });
});
