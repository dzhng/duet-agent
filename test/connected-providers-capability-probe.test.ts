import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { probeConnectedProvider } from "../src/connected-providers/capability-probe.js";
import type { OAuthCredentials } from "../src/connected-providers/store.js";

const credentials: OAuthCredentials = {
  access: "fixture-access-secret",
  refresh: "fixture-refresh-secret",
  expires: 2_000_000_000_000,
};

describe("connected provider capability probe", () => {
  test("a successful one-token completion marks ChatGPT eligible", async () => {
    const result = await probeConnectedProvider("openai-codex", credentials, {
      complete: completionFixture(200, "stop"),
    });

    expect(result).toEqual({
      eligibility: "eligible",
      servedModelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    });
  });

  test("HTTP 402 marks the plan ineligible without exposing provider detail", async () => {
    const result = await probeConnectedProvider("openai-codex", credentials, {
      complete: completionFixture(402, "error"),
    });

    expect(result).toEqual({
      eligibility: "plan_ineligible",
      servedModelIds: [],
      detail: "Provider plan does not cover the probe model.",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-access-secret");
  });

  test("HTTP 403 leaves eligibility unknown for reconnect handling", async () => {
    const result = await probeConnectedProvider("openai-codex", credentials, {
      complete: completionFixture(403, "error"),
    });

    expect(result).toEqual({
      eligibility: "unknown",
      servedModelIds: [],
      detail: "Capability probe failed with HTTP 403.",
    });
  });

  test("Copilot empty availability plus stop=error is deterministically plan-ineligible", async () => {
    const result = await probeConnectedProvider(
      "github-copilot",
      { ...credentials, availableModelIds: [] },
      { complete: completionFixture(200, "error") },
    );

    expect(result).toEqual({
      eligibility: "plan_ineligible",
      servedModelIds: [],
      detail: "No models are available for this Copilot plan.",
    });
  });

  test("a non-thrown 402 (stopReason error) still marks ChatGPT ineligible", async () => {
    const result = await probeConnectedProvider("openai-codex", credentials, {
      complete: reportedFailureFixture(402),
    });

    expect(result).toEqual({
      eligibility: "plan_ineligible",
      servedModelIds: [],
      detail: "Provider plan does not cover the probe model.",
    });
  });

  test("a transient Copilot failure with models available stays unknown", async () => {
    const result = await probeConnectedProvider(
      "github-copilot",
      { ...credentials, availableModelIds: ["claude-haiku-4.5"] },
      { complete: reportedFailureFixture(500) },
    );

    expect(result).toEqual({
      eligibility: "unknown",
      servedModelIds: [],
      detail: "Capability probe failed with HTTP 500.",
    });
  });
});

function completionFixture(
  status: number,
  stopReason: AssistantMessage["stopReason"],
): (
  model: Model<Api>,
  context: unknown,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage> {
  return async (model, _context, options) => {
    await options?.onResponse?.({ status, headers: {} }, model);
    if (status !== 200) throw new Error(`provider response ${status}: fixture-access-secret`);
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
  };
}

/** pi-ai transports report HTTP failures via onResponse + stopReason "error" without rejecting. */
function reportedFailureFixture(status: number) {
  const base = completionFixture(200, "error");
  return async (
    model: Model<Api>,
    context: unknown,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage> => {
    const message = await base(model, context, { ...options, onResponse: undefined });
    await options?.onResponse?.({ status, headers: {} }, model);
    return message;
  };
}
