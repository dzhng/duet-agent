import { describe, expect, test } from "bun:test";
import { chooseTransport } from "../src/connected-providers/transport-preference.js";

describe("connected provider transport preference", () => {
  test("prefers an eligible connected transport that covers a shorthand", () => {
    expect(
      chooseTransport("sol", {
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
      }),
    ).toEqual({
      transport: "openai-codex",
      modelId: "gpt-5.6-sol",
      planCovered: true,
      reason: "connected",
    });
  });

  test("truth table preserves pins, skips ineligible plans, and falls through missing coverage", () => {
    const cases = [
      {
        name: "no connections + covered shorthand",
        input: "sol",
        connections: [],
        expected: ["duet-gateway", "openai/gpt-5.6-sol", false, "router_order"],
      },
      {
        name: "eligible codex + covered shorthand",
        input: "sol",
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
        expected: ["openai-codex", "gpt-5.6-sol", true, "connected"],
      },
      {
        name: "unknown eligibility is usable until a probe rejects the plan",
        input: "sol",
        connections: [{ provider: "openai-codex", eligibility: "unknown" }],
        expected: ["openai-codex", "gpt-5.6-sol", true, "connected"],
      },
      {
        name: "plan-ineligible codex + covered shorthand",
        input: "sol",
        connections: [{ provider: "openai-codex", eligibility: "plan_ineligible" }],
        expected: ["duet-gateway", "openai/gpt-5.6-sol", false, "router_order"],
      },
      {
        name: "eligible copilot + covered shorthand",
        input: "opus-4.8",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["github-copilot", "claude-opus-4.8", true, "connected"],
      },
      {
        name: "eligible copilot + uncovered sonnet 5",
        input: "sonnet-5",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["duet-gateway", "anthropic/claude-sonnet-5", false, "router_order"],
      },
      {
        name: "both connections in reverse order + codex-only routed result",
        input: "sol",
        connections: [
          { provider: "github-copilot", eligibility: "eligible" },
          { provider: "openai-codex", eligibility: "eligible" },
        ],
        expected: ["openai-codex", "gpt-5.6-sol", true, "connected"],
      },
      {
        name: "both connections + copilot-only routed result",
        input: "haiku-4.5",
        connections: [
          { provider: "openai-codex", eligibility: "eligible" },
          { provider: "github-copilot", eligibility: "eligible" },
        ],
        expected: ["github-copilot", "claude-haiku-4.5", true, "connected"],
      },
      {
        name: "explicit router pin wins",
        input: "openrouter:openai/gpt-5.6-sol",
        connections: [{ provider: "openai-codex", eligibility: "eligible" }],
        expected: ["openrouter", "openai/gpt-5.6-sol", false, "explicit_pin"],
      },
      {
        name: "explicit connected pin wins even when the plan was marked ineligible",
        input: "github-copilot:claude-sonnet-5",
        connections: [{ provider: "github-copilot", eligibility: "plan_ineligible" }],
        expected: ["github-copilot", "claude-sonnet-5", true, "explicit_pin"],
      },
      {
        name: "unknown explicit provider passthrough wins",
        input: "anthropic:claude-future",
        connections: [{ provider: "github-copilot", eligibility: "eligible" }],
        expected: ["anthropic", "claude-future", false, "explicit_pin"],
      },
    ] as const;

    for (const { name, input, connections, expected } of cases) {
      const choice = chooseTransport(input, { connections });
      expect([choice.transport, choice.modelId, choice.planCovered, choice.reason], name).toEqual([
        ...expected,
      ]);
    }
  });
});
