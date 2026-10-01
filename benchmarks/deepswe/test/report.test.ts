import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";
import {
  buildDeepSwePairedReport,
  buildDeepSweReport,
  findMissingDeepSweArms,
  isRetryableInfrastructureException,
  loadDeepSweCampaignTaskIds,
  loadDeepSweResults,
  type DeepSweResultRow,
} from "../src/report.js";

describe("DeepSWE reporting", () => {
  test("rejects a headline when standalone pure baselines are missing", () => {
    const rows: DeepSweResultRow[] = [
      { arm: "glm-pure", taskId: "task", resolved: true, costUsd: 1 },
      { arm: "glm-kimi-advisor", taskId: "task", resolved: true, costUsd: 1 },
      { arm: "kimi-pure", taskId: "task", resolved: true, costUsd: 1 },
      { arm: "kimi-fable-advisor", taskId: "task", resolved: true, costUsd: 1 },
    ];

    expect(findMissingDeepSweArms(rows, ["task"])).toEqual([
      { taskId: "task", missing: ["opus-pure", "fable-pure"] },
    ]);
  });

  testIfDocker("uses the frozen campaign subset as the paired denominator", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-campaign-"));
    await writeFile(
      join(root, "campaign.json"),
      JSON.stringify({ taskIds: ["task-one", "task-two"] }),
    );

    expect(await loadDeepSweCampaignTaskIds(root, ["task-one", "task-two", "task-three"])).toEqual([
      "task-one",
      "task-two",
    ]);
  });

  test("retries infrastructure without retrying model or verifier outcomes", () => {
    expect(isRetryableInfrastructureException("EnvironmentStartTimeoutError")).toBe(true);
    expect(isRetryableInfrastructureException("RuntimeError")).toBe(true);
    expect(isRetryableInfrastructureException("AgentTimeoutError")).toBe(false);
    expect(isRetryableInfrastructureException("VerifierTimeoutError")).toBe(false);
    expect(isRetryableInfrastructureException(undefined)).toBe(false);
  });

  test("treats both-resolved as a tie and preserves pure-only regressions", () => {
    const rows: DeepSweResultRow[] = [
      { arm: "glm-pure", taskId: "tie", resolved: true, costUsd: 2 },
      { arm: "glm-kimi-advisor", taskId: "tie", resolved: true, costUsd: 1 },
      { arm: "glm-pure", taskId: "regression", resolved: true, costUsd: 2 },
      { arm: "glm-kimi-advisor", taskId: "regression", resolved: false, costUsd: 1 },
    ];
    const report = buildDeepSweReport(rows);
    expect(report.find((row) => row.arm === "glm-pure")).toMatchObject({
      resolved: 2,
      completed: 2,
      costPerResolvedUsd: 2,
    });
    expect(report.find((row) => row.arm === "glm-kimi-advisor")).toMatchObject({
      resolved: 1,
      completed: 2,
      costPerResolvedUsd: 2,
    });
    expect(buildDeepSwePairedReport(rows)[0]).toMatchObject({
      pair: "glm",
      completedTasks: 2,
      bothResolved: 1,
      advisorOnly: 0,
      pureOnlyRegression: 1,
      neitherResolved: 0,
      missingArms: [],
    });
  });

  test("excludes incomplete pairs from the denominator and reports their missing arm", () => {
    const rows: DeepSweResultRow[] = [
      { arm: "kimi-pure", taskId: "complete", resolved: false, costUsd: 1 },
      { arm: "kimi-fable-advisor", taskId: "complete", resolved: true, costUsd: 2 },
      { arm: "kimi-pure", taskId: "incomplete", resolved: true, costUsd: 1 },
    ];
    expect(buildDeepSwePairedReport(rows)[1]).toEqual({
      pair: "kimi",
      completedTasks: 1,
      bothResolved: 0,
      advisorOnly: 1,
      pureOnlyRegression: 0,
      neitherResolved: 0,
      missingArms: [{ taskId: "incomplete", missing: ["kimi-fable-advisor"] }],
    });
  });

  test("rejects a cost headline when a completed row has no accounting", () => {
    expect(() =>
      buildDeepSweReport([
        { arm: "glm-pure", taskId: "missing-cost", resolved: false, costUsd: null },
      ]),
    ).toThrow("missing-cost/glm-pure");
  });

  testIfDocker("ignores Pier's job-level result and loads only trial records", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-report-"));
    const trialRoot = join(root, "job", "trial");
    const opusRoot = join(root, "job", "opus");
    const fableRoot = join(root, "job", "fable");
    const infrastructureRoot = join(root, "job", "infrastructure");
    await mkdir(trialRoot, { recursive: true });
    await mkdir(opusRoot, { recursive: true });
    await mkdir(fableRoot, { recursive: true });
    await mkdir(infrastructureRoot, { recursive: true });
    await writeFile(join(root, "job", "result.json"), JSON.stringify({ n_trials: 1 }));
    await writeFile(
      join(trialRoot, "result.json"),
      JSON.stringify({
        task_name: "datacurve/example-task",
        agent_info: { model_info: { name: "glm-pure" } },
        agent_result: { cost_usd: 1.25 },
        verifier_result: { rewards: { reward: 1 } },
      }),
    );
    await writeFile(
      join(infrastructureRoot, "result.json"),
      JSON.stringify({
        task_name: "datacurve/example-task",
        agent_info: { model_info: { name: "glm-kimi-advisor" } },
        exception_info: { exception_type: "EnvironmentStartTimeoutError" },
      }),
    );
    await writeFile(
      join(opusRoot, "result.json"),
      JSON.stringify({
        task_name: "datacurve/example-task",
        agent_info: { model_info: { name: "opus-pure" } },
        agent_result: { cost_usd: 3.5 },
        verifier_result: { rewards: { reward: 1 } },
      }),
    );
    await writeFile(
      join(fableRoot, "result.json"),
      JSON.stringify({
        task_name: "datacurve/example-task",
        agent_info: { model_info: { name: "fable-pure" } },
        agent_result: { cost_usd: 2.5 },
        verifier_result: { rewards: { reward: 0 } },
      }),
    );
    const rows = await loadDeepSweResults(root);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          arm: "glm-pure",
          taskId: "example-task",
          resolved: true,
          costUsd: 1.25,
        },
        {
          arm: "fable-pure",
          taskId: "example-task",
          resolved: false,
          costUsd: 2.5,
        },
        {
          arm: "opus-pure",
          taskId: "example-task",
          resolved: true,
          costUsd: 3.5,
        },
      ]),
    );
  });
});
