import { describe, expect, test } from "bun:test";
import { resolveModelReference } from "../src/model-resolution/resolver.js";

describe("connected-provider model resolution", () => {
  test("falls through to router order when Copilot availableModelIds filters the requested model", () => {
    const previous = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "duet_gt_resolver_test";
    try {
      const resolved = resolveModelReference("opus-4.7", {
        snapshot: () => ({
          connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        }),
        apiKey: () => "copilot-token",
        applyHook: () => undefined,
        refresh: () => undefined,
      });

      expect(resolved).toBe("duet-gateway:anthropic/claude-opus-4.7");
    } finally {
      if (previous === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = previous;
    }
  });
});
