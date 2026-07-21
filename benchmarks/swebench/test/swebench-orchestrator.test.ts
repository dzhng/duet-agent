import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGLITE_RUNTIME_ASSET_NAMES } from "../../../src/memory/pglite.js";
import {
  beginRolloutAttempt,
  hashJson,
  hashText,
  type RolloutArtifactSpec,
  type RolloutAttempt,
} from "../src/artifacts.js";
import { type CampaignConfigName, CAMPAIGN_CONFIGS } from "../src/config-override.js";
import {
  filterPlanForExecution,
  planCampaign,
  reserveInstanceBlock,
  runCampaign,
  type CampaignRuntime,
  type CampaignSpec,
} from "../src/orchestrator.js";
import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("SWE-bench campaign resume planning", () => {
  test("orders every configured arm deterministically inside each instance block", () => {
    const { campaign, runtime } = fixture();
    const first = planCampaign(campaign, runtime, [], false);
    const second = planCampaign(campaign, runtime, [], false);
    const armCount = campaign.configs.length;

    expect(first).toEqual(second);
    expect(first).toHaveLength(runtime.manifest.entries.length * armCount);
    expect(first.slice(0, armCount).every((item) => item.entry.instanceId === "org__repo-1")).toBe(
      true,
    );
    expect(new Set(first.slice(0, armCount).map((item) => item.config))).toEqual(
      new Set(Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[]),
    );
  });

  test("a matching complete plan is idempotent and stale running work resumes", () => {
    const { campaign, runtime } = fixture();
    const planned = planCampaign(campaign, runtime, [], false);
    const completed = planned.map((item, index) =>
      fixtureAttempt(campaign, runtime, item.entry.instanceId, item.config, "completed", index + 1),
    );
    expect(planCampaign(campaign, runtime, completed, false)).toEqual([]);

    completed[3] = fixtureAttempt(
      campaign,
      runtime,
      completed[3]!.spec.instanceId,
      completed[3]!.spec.config,
      "running",
      1,
    );
    expect(planCampaign(campaign, runtime, completed, false)).toHaveLength(1);
  });

  test("retries only infrastructure failures when requested and refuses spec drift", () => {
    const { campaign, runtime } = fixture();
    const infra = fixtureAttempt(campaign, runtime, "org__repo-1", "glm-pure", "failed", 1);
    infra.status.failureKind = "infra";
    const total = runtime.manifest.entries.length * campaign.configs.length;
    expect(planCampaign(campaign, runtime, [infra], false)).toHaveLength(total - 1);
    expect(planCampaign(campaign, runtime, [infra], true)).toHaveLength(total);

    runtime.configHashes["glm-pure"] = "changed";
    expect(() => planCampaign(campaign, runtime, [infra], true)).toThrow("specHash mismatch");
  });

  test("filters a full frozen plan to one remote instance block", () => {
    const { campaign, runtime } = fixture();
    const plan = planCampaign(campaign, runtime, [], false);

    const selected = filterPlanForExecution(plan, ["org__repo-2"], runtime.manifest);

    expect(selected).toHaveLength(campaign.configs.length);
    expect(selected.every((item) => item.entry.instanceId === "org__repo-2")).toBe(true);
    expect(() => filterPlanForExecution(plan, ["missing__repo-1"], runtime.manifest)).toThrow(
      "Execution selection is not in the manifest: missing__repo-1",
    );
  });

  test("filters a frozen plan to one remote instance-trial shard", () => {
    const { campaign, runtime } = fixture();
    campaign.trials = 3;
    const plan = planCampaign(campaign, runtime, [], false);

    const selected = filterPlanForExecution(plan, ["org__repo-2"], runtime.manifest, [2]);

    expect(selected).toHaveLength(campaign.configs.length);
    expect(selected.every((item) => item.entry.instanceId === "org__repo-2")).toBe(true);
    expect(selected.every((item) => item.trial === 2)).toBe(true);
  });

  test("admits an instance block only when every pending arm fits the budget", () => {
    expect(reserveInstanceBlock(487.6, 4, 3.1, 500)).toBe(500);
    expect(() => reserveInstanceBlock(487.61, 4, 3.1, 500)).toThrow(
      "4 pending rollouts require a $12.4000 reserve",
    );
  });

  testIfDocker("keeps a started rollout reserved when it throws after model work", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "duet-swebench-budget-"));
    try {
      const { campaign, runtime } = fixture();
      const thirdEntry = {
        instanceId: "org__repo-3",
        language: "Go" as const,
        repo: "org/repo",
        baseCommit: "org__repo-3",
      };
      runtime.runsRoot = runsRoot;
      runtime.manifest = {
        ...runtime.manifest,
        entries: [...runtime.manifest.entries, thirdEntry],
      };
      runtime.datasetRows = [
        ...runtime.datasetRows,
        {
          instanceId: thirdEntry.instanceId,
          repo: thirdEntry.repo,
          baseCommit: thirdEntry.baseCommit,
          problemStatement: `Fix ${thirdEntry.instanceId}`,
        },
      ];
      campaign.configs = ["glm-pure"];
      campaign.concurrency = 2;
      campaign.limits.costUsd = 1;
      campaign.budget = { totalUsd: 2, sunkUsd: 0 };

      let startSecond!: () => void;
      const secondStarted = new Promise<void>((resolve) => (startSecond = resolve));
      const launched: string[] = [];
      runtime.resolveOfficialImage = async (instanceId) => ({
        image: `official/${instanceId}:latest`,
        imageId: `sha256:${instanceId}`,
        platform: "linux/amd64",
        sizeBytes: 1,
      });
      runtime.removeOfficialImage = async () => {};
      runtime.rolloutRunner = async (...args) => {
        const spec = args[1];
        launched.push(spec.entry.instanceId);
        if (spec.entry.instanceId === "org__repo-1") {
          await secondStarted;
          throw new Error("rollout threw after model work");
        }
        if (spec.entry.instanceId === "org__repo-2") startSecond();
        const attempt = fixtureAttempt(
          campaign,
          runtime,
          spec.entry.instanceId,
          spec.config,
          "completed",
          1,
        );
        attempt.status.costUsd = 1;
        return { attempt, status: attempt.status };
      };

      await expect(runCampaign(campaign, runtime, { retryFailed: false })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(launched).toContain("org__repo-1");
      expect(launched).toContain("org__repo-2");
      expect(launched).not.toContain("org__repo-3");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  testIfDocker("refuses to mix a changed official image into a resumed campaign", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "duet-swebench-image-id-"));
    try {
      const { campaign, runtime } = fixture();
      const instanceId = runtime.manifest.entries[0]!.instanceId;
      campaign.configs = ["glm-pure"];
      campaign.instanceIds = [instanceId];
      runtime.runsRoot = runsRoot;
      const prior = fixtureAttempt(campaign, runtime, instanceId, "glm-pure", "running", 1);
      await beginRolloutAttempt(runsRoot, prior.spec);
      runtime.resolveOfficialImage = async () => ({
        image: prior.spec.image,
        imageId: "sha256:changed",
        platform: "linux/amd64",
        sizeBytes: 1,
      });
      runtime.removeOfficialImage = async () => {};

      await expect(runCampaign(campaign, runtime, { retryFailed: false })).rejects.toThrow(
        `Official image changed for ${instanceId}`,
      );
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  testIfDocker("reconciles request overshoot before admitting the next block", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "duet-swebench-overshoot-"));
    try {
      const { campaign, runtime } = fixture();
      campaign.configs = ["glm-pure"];
      campaign.concurrency = 1;
      campaign.limits.costUsd = 1;
      campaign.budget = { totalUsd: 1, sunkUsd: 0 };
      runtime.runsRoot = runsRoot;
      runtime.resolveOfficialImage = async (instanceId) => ({
        image: `official/${instanceId}:latest`,
        imageId: `sha256:${instanceId}`,
        platform: "linux/amd64",
        sizeBytes: 1,
      });
      const removed: string[] = [];
      runtime.removeOfficialImage = async (imageId) => {
        removed.push(imageId);
      };
      const launched: string[] = [];
      runtime.rolloutRunner = async (...args) => {
        const spec = args[1];
        launched.push(spec.entry.instanceId);
        const attempt = fixtureAttempt(
          campaign,
          runtime,
          spec.entry.instanceId,
          spec.config,
          "completed",
          1,
        );
        attempt.status.costUsd = 1.5;
        return { attempt, status: attempt.status };
      };

      await expect(runCampaign(campaign, runtime, { retryFailed: false })).rejects.toThrow(
        "Campaign budget exceeded after provider-reported spend",
      );
      expect(launched).toEqual(["org__repo-1"]);
      expect(removed).toEqual(["sha256:org__repo-1"]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

function fixture(): { campaign: CampaignSpec; runtime: CampaignRuntime } {
  const configs = Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[];
  const campaign: CampaignSpec = {
    schemaVersion: 1,
    id: "fixture-campaign",
    manifestPath: "manifest.json",
    configs,
    trials: 1,
    concurrency: 1,
    armOrderSeed: 42,
    limits: {
      costUsd: 1,
      wallClockMs: 1000,
      interruptGraceMs: 10,
      patchBytes: 1000,
    },
    budget: { totalUsd: 500, sunkUsd: 0 },
  };
  const entries = ["org__repo-1", "org__repo-2"].map((instanceId) => ({
    instanceId,
    language: "Go" as const,
    repo: "org/repo",
    baseCommit: instanceId,
  }));
  const runtime: CampaignRuntime = {
    repoRoot: "/repo",
    runsRoot: "/runs",
    artifact: {
      localPath: "/duet",
      installPath: "/opt/duet/duet",
      sha256: "a".repeat(64),
      runtimeAssets: PGLITE_RUNTIME_ASSET_NAMES.map((name) => ({
        name,
        localPath: `/${name}`,
        installPath: `/opt/duet/${name}` as const,
        sha256: "b".repeat(64),
      })),
      packagingMode: "compiled-linux-x64",
    },
    manifest: {
      datasetRevision: "revision",
      seed: 1,
      algorithmVersion: "language-stratified-v2",
      excludedInstanceIds: [],
      entries,
    },
    datasetRows: entries.map((entry) => ({
      instanceId: entry.instanceId,
      repo: entry.repo,
      baseCommit: entry.baseCommit,
      problemStatement: `Fix ${entry.instanceId}`,
    })),
    configPaths: Object.fromEntries(
      configs.map((config) => [config, `/configs/${config}.json`]),
    ) as Record<CampaignConfigName, string>,
    configHashes: Object.fromEntries(configs.map((config) => [config, `hash-${config}`])) as Record<
      CampaignConfigName,
      string
    >,
    providerEnv: {},
    pythonPath: "/venv/python",
    imageHelperPath: "/official_image.py",
  };
  return { campaign, runtime };
}

function fixtureAttempt(
  campaign: CampaignSpec,
  runtime: CampaignRuntime,
  instanceId: string,
  config: CampaignConfigName,
  phase: "running" | "completed" | "failed",
  attempt: number,
): RolloutAttempt {
  const row = runtime.datasetRows.find((candidate) => candidate.instanceId === instanceId)!;
  const spec: RolloutArtifactSpec = {
    campaignId: campaign.id,
    config,
    instanceId,
    trial: 1,
    image: "official/image",
    imageId: "sha256:official",
    duetSha256: runtime.artifact.sha256,
    configSha256: runtime.configHashes[config],
    systemPromptSha256: hashText(SWEBENCH_SYSTEM_PROMPT),
    promptSha256: hashText(buildRolloutPrompt({ problemStatement: row.problemStatement })),
    limits: campaign.limits,
  };
  return {
    directory: `/runs/${instanceId}/${config}/${attempt}`,
    spec,
    status: {
      schemaVersion: 1,
      phase,
      specHash: hashJson(spec),
      attempt,
      startedAt: "2026-07-20T00:00:00.000Z",
      ...(phase === "running" ? {} : { finishedAt: "2026-07-20T00:01:00.000Z" }),
      ...(phase === "completed" ? { costUsd: 0.25 } : {}),
    },
  };
}
