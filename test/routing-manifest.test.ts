import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_DUET_GATEWAY_TIER_CLOSURES,
  projectDuetGatewayTierClosures,
} from "../src/routing-manifest.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

describe("duet-gateway routing manifest", () => {
  test("projects routes, vision fallbacks, enabled advisors, and shared internal models", () => {
    expect(projectDuetGatewayTierClosures(BUILT_IN_ROUTING_TABLE)).toEqual({
      frontier: [
        "moonshotai/kimi-k3",
        "anthropic/claude-fable-5",
        "openai/gpt-5.6-sol",
        "anthropic/claude-opus-5",
        "openai/gpt-5.6-luna",
        "google/gemini-embedding-2",
      ],
      balanced: [
        "moonshotai/kimi-k3",
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-terra",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-fable-5",
        "openai/gpt-5.6-luna",
        "google/gemini-embedding-2",
      ],
      economy: ["openai/gpt-5.6-luna", "zai/glm-5.2", "google/gemini-embedding-2"],
    });
    expect(BUILT_IN_DUET_GATEWAY_TIER_CLOSURES).toEqual(
      projectDuetGatewayTierClosures(BUILT_IN_ROUTING_TABLE),
    );

    // Economy's disabled Terra advisor is configuration documentation only,
    // not callable traffic and therefore not part of its billing closure.
    expect(BUILT_IN_DUET_GATEWAY_TIER_CLOSURES.economy).not.toContain("openai/gpt-5.6-terra");
  });

  test("follows a distinct configured vision fallback and ignores a disabled advisor target", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes.implement.visionFallbackModelName = "kimi";
    table.tiers.economy.advisor.target.modelName = "sol";

    const projected = projectDuetGatewayTierClosures(table);

    expect(projected.economy).toContain("moonshotai/kimi-k3");
    expect(projected.economy).not.toContain("openai/gpt-5.6-sol");
  });
});
