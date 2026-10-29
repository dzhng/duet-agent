import { describe, expect } from "bun:test";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";
import { DEEPSWE_ARM_NAMES } from "../src/config.js";
import { pruneInfrastructureTrials, taskHasAllOutcomes } from "../e2b/run.js";

describe("DeepSWE infrastructure resume", () => {
  testIfDocker("requires one durable outcome from every configured arm", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-completion-"));
    const jobsRoot = join(root, "jobs");
    for (const arm of DEEPSWE_ARM_NAMES.slice(0, -1)) {
      const trial = join(jobsRoot, arm);
      await mkdir(trial, { recursive: true });
      await writeFile(
        join(trial, "result.json"),
        JSON.stringify({
          task_name: "datacurve/task",
          agent_info: { model_info: { name: arm } },
          agent_result: { cost_usd: 1 },
          verifier_result: { rewards: { reward: 0 } },
        }),
      );
    }

    expect(await taskHasAllOutcomes(root, "task")).toBe(false);

    const finalArm = DEEPSWE_ARM_NAMES.at(-1)!;
    const finalTrial = join(jobsRoot, finalArm);
    await mkdir(finalTrial, { recursive: true });
    await writeFile(
      join(finalTrial, "result.json"),
      JSON.stringify({
        task_name: "datacurve/task",
        agent_info: { model_info: { name: finalArm } },
        agent_result: { cost_usd: 1 },
        verifier_result: { rewards: { reward: 1 } },
      }),
    );

    expect(await taskHasAllOutcomes(root, "task")).toBe(true);
  });

  testIfDocker("removes resumable Pier trials without deleting model outcomes", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-resume-"));
    const infrastructure = join(root, "job", "infrastructure");
    const modelTimeout = join(root, "job", "model-timeout");
    await Promise.all([
      mkdir(infrastructure, { recursive: true }),
      mkdir(modelTimeout, { recursive: true }),
    ]);
    const base = {
      task_name: "datacurve/task",
      agent_info: { model_info: { name: "glm-pure" } },
    };
    await Promise.all([
      writeFile(
        join(infrastructure, "result.json"),
        JSON.stringify({
          ...base,
          exception_info: { exception_type: "EnvironmentStartTimeoutError" },
        }),
      ),
      writeFile(
        join(modelTimeout, "result.json"),
        JSON.stringify({
          ...base,
          exception_info: { exception_type: "AgentTimeoutError" },
        }),
      ),
    ]);

    expect(await pruneInfrastructureTrials(root)).toBe(1);
    expect(await exists(infrastructure)).toBe(false);
    expect(await exists(modelTimeout)).toBe(true);
  });
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
