import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { RolloutAttempt } from "../src/artifacts.js";
import type { InstanceManifest } from "../src/manifest.js";
import type { CampaignSpec } from "../src/orchestrator.js";
import {
  calculateCampaignBudgetBound,
  integrateInstanceArtifacts,
  retryE2BRead,
  retryE2BSandboxCreate,
  selectE2BInstanceIds,
} from "../e2b/run.js";
import { buildE2BEnvironmentLock, e2bTemplateName, providerEnvironment } from "../e2b/support.js";
import { testIfDocker } from "./helpers/docker-only.js";

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
        duetArtifactSha256: "a".repeat(64),
        runtimeAssetSha256: {
          "pglite.data": "b".repeat(64),
          "pglite.wasm": "c".repeat(64),
          "initdb.wasm": "d".repeat(64),
          "vector.tar.gz": "e".repeat(64),
        },
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
      duetArtifact: {
        sha256: "a".repeat(64),
        runtimeAssetSha256: {
          "pglite.data": "b".repeat(64),
          "pglite.wasm": "c".repeat(64),
          "initdb.wasm": "d".repeat(64),
          "vector.tar.gz": "e".repeat(64),
        },
      },
      python: { version: "3.12.3", swebenchVersion: "4.1.0" },
    });
  });

  test("reserves the global model budget across independent E2B shards and retries", () => {
    const { spec, manifest } = campaignFixture();
    const initial = calculateCampaignBudgetBound(spec, manifest, [], false);
    expect({ pending: initial.pending, priorUsd: initial.priorUsd }).toEqual({
      pending: 120,
      priorUsd: 0,
    });
    expect(initial.totalUsd).toBeCloseTo(498.84, 8);

    const failedInfra = attemptFixture(spec);
    const held = calculateCampaignBudgetBound(spec, manifest, [failedInfra], false);
    expect({ pending: held.pending, priorUsd: held.priorUsd }).toEqual({
      pending: 119,
      priorUsd: 1,
    });
    expect(held.totalUsd).toBeCloseTo(495.87, 8);

    const retried = calculateCampaignBudgetBound(spec, manifest, [failedInfra], true);
    expect({ pending: retried.pending, priorUsd: retried.priorUsd }).toEqual({
      pending: 120,
      priorUsd: 1,
    });
    expect(retried.totalUsd).toBeCloseTo(499.84, 8);
  });

  test("defaults E2B workers to the campaign instance subset", () => {
    const { spec, manifest } = campaignFixture();
    spec.instanceIds = ["org__repo-3", "org__repo-1"];

    expect(selectE2BInstanceIds(spec, manifest, [])).toEqual(["org__repo-3", "org__repo-1"]);
    expect(selectE2BInstanceIds(spec, manifest, ["org__repo-1"])).toEqual(["org__repo-1"]);
    expect(() => selectE2BInstanceIds(spec, manifest, ["org__repo-2"])).toThrow(
      "not selected by the campaign",
    );
  });

  testIfDocker("integrates concurrent worker artifacts without racing on provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "swebench-e2b-artifacts-"));
    const destination = join(root, "campaign");
    const { spec } = campaignFixture();
    const provenance = (startedAt: string) =>
      `${JSON.stringify({ schemaVersion: 1, inputHash: "same", startedAt, frozen: { spec: "frozen" } })}\n`;
    const workers = [
      { instanceId: "org__repo-1", evidence: "first-worker\n" },
      { instanceId: "org__repo-2", evidence: "second-worker\n" },
    ];

    try {
      const stagedRoots = await Promise.all(
        workers.map(async ({ instanceId, evidence }, index) => {
          const stagedRoot = join(root, `staged-${index}`);
          const attemptRoot = join(stagedRoot, "glm-pure", `${instanceId}-t1`);
          await mkdir(attemptRoot, { recursive: true });
          await Promise.all([
            writeFile(join(stagedRoot, "campaign.json"), provenance(`worker-${index}`)),
            writeFile(join(attemptRoot, "evidence.txt"), evidence),
          ]);
          return stagedRoot;
        }),
      );

      await Promise.all(
        workers.map(({ instanceId }, index) =>
          integrateInstanceArtifacts(stagedRoots[index]!, destination, spec, instanceId),
        ),
      );

      expect(JSON.parse(await readFile(join(destination, "campaign.json"), "utf8"))).toEqual(
        expect.objectContaining({ inputHash: "same", frozen: { spec: "frozen" } }),
      );
      expect(
        await Promise.all(
          workers.map(({ instanceId }) =>
            readFile(join(destination, "glm-pure", `${instanceId}-t1`, "evidence.txt"), "utf8"),
          ),
        ),
      ).toEqual(workers.map(({ evidence }) => evidence));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("rejects worker artifacts from conflicting campaign provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "swebench-e2b-provenance-"));
    const destination = join(root, "campaign");
    const first = join(root, "first");
    const conflicting = join(root, "conflicting");
    const { spec } = campaignFixture();

    try {
      await Promise.all([
        mkdir(join(first, "glm-pure", "org__repo-1-t1"), { recursive: true }),
        mkdir(join(conflicting, "glm-pure", "org__repo-2-t1"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(first, "campaign.json"),
          '{"schemaVersion":1,"inputHash":"first","frozen":{"spec":"first"}}\n',
        ),
        writeFile(
          join(conflicting, "campaign.json"),
          '{"schemaVersion":1,"inputHash":"other","frozen":{"spec":"other"}}\n',
        ),
      ]);

      await integrateInstanceArtifacts(first, destination, spec, "org__repo-1");
      await expect(
        integrateInstanceArtifacts(conflicting, destination, spec, "org__repo-2"),
      ).rejects.toThrow("does not match existing campaign.json");
      expect(await readFile(join(destination, "campaign.json"), "utf8")).toContain(
        '"inputHash":"first"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries sandbox creation only after cleaning an unconnected attempt", async () => {
    let attempts = 0;
    let cleanups = 0;
    const delays: number[] = [];

    const result = await retryE2BSandboxCreate(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient controller failure");
        return "sandbox";
      },
      async () => {
        cleanups += 1;
      },
      [2, 5],
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );

    expect(result).toBe("sandbox");
    expect(attempts).toBe(3);
    expect(cleanups).toBe(2);
    expect(delays).toEqual([2, 5]);
  });

  test("retries read-only controller requests without cleanup side effects", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryE2BRead(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient controller failure");
        return true;
      },
      [2, 5],
      async (milliseconds) => {
        delays.push(milliseconds);
      },
    );

    expect(result).toBeTrue();
    expect(attempts).toBe(3);
    expect(delays).toEqual([2, 5]);
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
        costUsd: 3.97,
        wallClockMs: 1_800_000,
        interruptGraceMs: 90_000,
        patchBytes: 5_242_880,
      },
      budget: { totalUsd: 500, sunkUsd: 22.44 },
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
