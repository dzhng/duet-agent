import { describe, expect, test } from "bun:test";

import {
  hashJson,
  hashText,
  type RolloutArtifactSpec,
  type RolloutAttempt,
} from "../src/artifacts.js";
import { type CampaignConfigName, CAMPAIGN_CONFIGS } from "../src/config-override.js";
import {
  filterPlanForExecution,
  planCampaign,
  type CampaignRuntime,
  type CampaignSpec,
} from "../src/orchestrator.js";
import { buildRolloutPrompt, SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";

describe("SWE-bench campaign resume planning", () => {
  test("orders four arms deterministically inside each instance block", () => {
    const { campaign, runtime } = fixture();
    const first = planCampaign(campaign, runtime, [], false);
    const second = planCampaign(campaign, runtime, [], false);

    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    expect(first.slice(0, 4).every((item) => item.entry.instanceId === "org__repo-1")).toBe(true);
    expect(new Set(first.slice(0, 4).map((item) => item.config))).toEqual(
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
    expect(planCampaign(campaign, runtime, [infra], false)).toHaveLength(7);
    expect(planCampaign(campaign, runtime, [infra], true)).toHaveLength(8);

    runtime.configHashes["glm-pure"] = "changed";
    expect(() => planCampaign(campaign, runtime, [infra], true)).toThrow("specHash mismatch");
  });

  test("filters a full frozen plan to one remote instance block", () => {
    const { campaign, runtime } = fixture();
    const plan = planCampaign(campaign, runtime, [], false);

    const selected = filterPlanForExecution(plan, ["org__repo-2"], runtime.manifest);

    expect(selected).toHaveLength(4);
    expect(selected.every((item) => item.entry.instanceId === "org__repo-2")).toBe(true);
    expect(() => filterPlanForExecution(plan, ["missing__repo-1"], runtime.manifest)).toThrow(
      "Execution selection is not in the manifest: missing__repo-1",
    );
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
  const entry = runtime.manifest.entries.find((candidate) => candidate.instanceId === instanceId)!;
  const row = runtime.datasetRows.find((candidate) => candidate.instanceId === instanceId)!;
  const spec: RolloutArtifactSpec = {
    campaignId: campaign.id,
    config,
    instanceId,
    trial: 1,
    image: "official/image",
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
