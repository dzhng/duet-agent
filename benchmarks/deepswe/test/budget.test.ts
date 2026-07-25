import { describe, expect, test } from "bun:test";

import { resolveDuetGatewayModel } from "../../../src/model-resolution/duet-gateway.js";
import { deepSweMinimumBudgetUsd, DEEPSWE_SINGLE_REQUEST_CUSHION_USD } from "../src/budget.js";
import {
  DEEPSWE_AGENT_TIMEOUT_SEC,
  DEEPSWE_ENVIRONMENT_BUILD_TIMEOUT_SEC,
  DEEPSWE_VERIFIER_TIMEOUT_SEC,
  DEEPSWE_VERIFIER_ENVIRONMENT_BUILD_TIMEOUT_SEC,
  DEEPSWE_WORKER_COMMAND_TIMEOUT_MS,
  DEEPSWE_WORKER_TIMEOUT_MS,
} from "../src/timing.js";

describe("DeepSWE paid-run admission", () => {
  test("reserves one bounded request beyond every soft rollout stop", () => {
    expect(deepSweMinimumBudgetUsd(10, 10)).toBe(1_200);
  });

  test("covers the maximum catalog-priced request in every pilot model", () => {
    for (const modelId of [
      "zai/glm-5.2",
      "moonshotai/kimi-k3",
      "anthropic/claude-fable-5",
      "openai/gpt-5.6-luna",
    ]) {
      const model = resolveDuetGatewayModel(modelId);
      const highestInputRate = Math.max(
        model.cost.input,
        model.cost.cacheRead,
        model.cost.cacheWrite,
      );
      const conservativeRequestCost =
        (model.contextWindow * highestInputRate + model.maxTokens * model.cost.output) / 1_000_000;
      expect(conservativeRequestCost).toBeLessThanOrEqual(DEEPSWE_SINGLE_REQUEST_CUSHION_USD);
    }
  });

  test("allows all four agent and verifier ceilings plus setup and transfer headroom", () => {
    const bareTrialCeilingsMs =
      4 *
      (DEEPSWE_AGENT_TIMEOUT_SEC +
        DEEPSWE_VERIFIER_TIMEOUT_SEC +
        DEEPSWE_ENVIRONMENT_BUILD_TIMEOUT_SEC +
        DEEPSWE_VERIFIER_ENVIRONMENT_BUILD_TIMEOUT_SEC) *
      1_000;
    expect(DEEPSWE_WORKER_COMMAND_TIMEOUT_MS).toBeGreaterThan(bareTrialCeilingsMs);
    expect(DEEPSWE_WORKER_TIMEOUT_MS).toBeGreaterThan(DEEPSWE_WORKER_COMMAND_TIMEOUT_MS);
  });
});
