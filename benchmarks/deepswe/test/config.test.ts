import { describe, expect, test } from "bun:test";

import { BUILT_IN_ROUTING_TABLE } from "../../../src/model-routing/table.js";
import { DEEPSWE_TIER, renderDeepSweConfigs, type DeepSweArmName } from "../src/config.js";

describe("DeepSWE model arms", () => {
  test("pure and advised pairs differ only in advisor availability", () => {
    const configs = renderDeepSweConfigs();
    expect(normalize(configs["glm-pure"])).toEqual(normalize(configs["glm-kimi-advisor"]));
    expect(normalize(configs["kimi-pure"])).toEqual(normalize(configs["kimi-fable-advisor"]));
  });

  test("keeps product classifier defaults and changes no memory model", () => {
    for (const config of Object.values(renderDeepSweConfigs())) {
      expect(config.classifier).toEqual(BUILT_IN_ROUTING_TABLE.classifier);
      expect(config.defaultTier).toBe(DEEPSWE_TIER);
      expect(config.tiers[DEEPSWE_TIER]?.routes.general?.visionFallbackModelName).toBe("kimi-k3");
      expect("memory" in config).toBe(false);
    }
  });
});

function normalize(
  config: ReturnType<typeof renderDeepSweConfigs>[DeepSweArmName],
): ReturnType<typeof renderDeepSweConfigs>[DeepSweArmName] {
  const value = structuredClone(config);
  const advisor = value.tiers[DEEPSWE_TIER]?.advisor;
  if (!advisor) throw new Error("Missing DeepSWE advisor.");
  advisor.enabled = false;
  return value;
}
