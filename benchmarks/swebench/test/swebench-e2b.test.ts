import { describe, expect, test } from "bun:test";

import type { RolloutAttempt } from "../src/artifacts.js";
import type { InstanceManifest } from "../src/manifest.js";
import type { CampaignSpec } from "../src/orchestrator.js";
import { calculateCampaignBudgetBound } from "../e2b/run.js";
import { buildE2BEnvironmentLock, e2bTemplateName, providerEnvironment } from "../e2b/support.js";

describe("SWE-bench E2B execution", () => {
  test("derives an immutable path-safe template name from the full git SHA", () => {
    expect(e2bTemplateName("ABCDEF0123456789abcdef0123456789abcdef01")).toBe(
      "duet-swebench-abcdef012345",
    );
    expect(() => e2bTemplateName("not-a-sha")).toThrow("full git SHA");
  });

  test("forwards only supported provider credentials", () => {
    expect(
      providerEnvironment({
        E2B_API_KEY: "sandbox-secret",
        AI_GATEWAY_API_KEY: "gateway-secret",
        OPENROUTER_API_KEY: "router-secret",
        UNRELATED_SECRET: "must-not-forward",
      }),
    ).toEqual({
      AI_GATEWAY_API_KEY: "gateway-secret",
      OPENROUTER_API_KEY: "router-secret",
    });
    expect(() => providerEnvironment({ E2B_API_KEY: "sandbox-secret" })).toThrow(
      "No supported model gateway key",
    );
  });

  test("builds stable environment provenance without a sandbox identity", () => {
    expect(
      buildE2BEnvironmentLock({
        templateName: "duet-swebench-abcdef012345",
        templateId: "template-id",
        cpuCount: 8,
        memoryMb: 16_384,
        repositorySha: "abcdef0123456789abcdef0123456789abcdef01",
        architecture: "x86_64",
        osRelease: "Ubuntu 24.04.2 LTS",
        dockerClientVersion: "28.5.1",
        dockerServerVersion: "28.5.1",
        pythonVersion: "3.12.3",
        swebenchVersion: "4.1.0",
      }),
    ).toEqual({
      schemaVersion: 1,
      backend: "e2b",
      template: {
        name: "duet-swebench-abcdef012345",
        id: "template-id",
        repositorySha: "abcdef0123456789abcdef0123456789abcdef01",
      },
      worker: {
        architecture: "x86_64",
        cpuCount: 8,
        memoryMb: 16_384,
        osRelease: "Ubuntu 24.04.2 LTS",
      },
      docker: { clientVersion: "28.5.1", serverVersion: "28.5.1" },
      python: { version: "3.12.3", swebenchVersion: "4.1.0" },
    });
  });

  test("reserves the global model budget across independent E2B shards and retries", () => {
    const { spec, manifest } = campaignFixture();
    expect(calculateCampaignBudgetBound(spec, manifest, [], false)).toEqual({
      pending: 120,
      priorUsd: 0,
      totalUsd: 499.8,
    });

    const failedInfra = attemptFixture(spec);
    expect(calculateCampaignBudgetBound(spec, manifest, [failedInfra], false)).toEqual({
      pending: 119,
      priorUsd: 1,
      totalUsd: 496.81,
    });
    expect(calculateCampaignBudgetBound(spec, manifest, [failedInfra], true)).toEqual({
      pending: 120,
      priorUsd: 1,
      totalUsd: 500.8,
    });
  });
});

function campaignFixture(): { spec: CampaignSpec; manifest: InstanceManifest } {
  const configs = ["glm-pure", "glm-kimi-advisor", "kimi-pure", "kimi-fable-advisor"] as const;
  return {
    spec: {
      schemaVersion: 1,
      id: "campaign",
      manifestPath: "manifest.json",
      configs: [...configs],
      trials: 1,
      concurrency: 1,
      armOrderSeed: 1,
      limits: {
        costUsd: 3.99,
        wallClockMs: 1_800_000,
        interruptGraceMs: 90_000,
        patchBytes: 5_242_880,
      },
      budget: { totalUsd: 500, sunkUsd: 21 },
    },
    manifest: {
      datasetRevision: "revision",
      seed: 1,
      algorithmVersion: "language-stratified-v2",
      excludedInstanceIds: [],
      entries: Array.from({ length: 30 }, (_, index) => ({
        instanceId: `org__repo-${index + 1}`,
        language: "C" as const,
        repo: "org/repo",
        baseCommit: `commit-${index + 1}`,
      })),
    },
  };
}

function attemptFixture(spec: CampaignSpec): RolloutAttempt {
  return {
    directory: "/attempt",
    spec: {
      campaignId: spec.id,
      config: "glm-pure",
      instanceId: "org__repo-1",
      trial: 1,
      image: "image",
      duetSha256: "duet",
      configSha256: "config",
      systemPromptSha256: "system",
      promptSha256: "prompt",
      limits: spec.limits,
    },
    status: {
      schemaVersion: 1,
      phase: "failed",
      specHash: "hash",
      attempt: 1,
      startedAt: "2026-07-20T00:00:00.000Z",
      finishedAt: "2026-07-20T00:01:00.000Z",
      failureKind: "infra",
      costUsd: 1,
    },
  };
}
