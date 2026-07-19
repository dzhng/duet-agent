import { afterEach, describe, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CommandResult, CommandRunner } from "../benchmarks/swebench/src/container.js";
import type { ExecTransport } from "../benchmarks/swebench/src/duet-client.js";
import type { CampaignSpec } from "../benchmarks/swebench/src/orchestrator.js";
import { ensureCampaignProvenance } from "../benchmarks/swebench/src/provenance.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench campaign provenance", () => {
  testIfDocker("is write-once for matching inputs and refuses a dirty launch", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-provenance-"));
    const manifestPath = join(root, "manifest.json");
    const environmentPath = join(root, "environment.json");
    const configPath = join(root, "config.json");
    await Promise.all([
      writeFile(manifestPath, '{"datasetRevision":"revision"}\n'),
      writeFile(environmentPath, '{"python":{"swebenchVersion":"4.1.0"}}\n'),
      writeFile(configPath, '{"defaultTier":"swebench"}\n'),
      mkdir(join(root, "runs")),
    ]);
    const campaign = fixtureCampaign();
    const commands = new FakeGit("");
    const options = {
      repoRoot: root,
      runsRoot: join(root, "runs"),
      spec: campaign,
      artifact: {
        localPath: "/duet",
        installPath: "/opt/duet/duet" as const,
        sha256: "a".repeat(64),
        packagingMode: "compiled-linux-x64" as const,
      },
      manifestPath,
      configPaths: {
        "glm-pure": configPath,
        "glm-kimi-advisor": configPath,
        "kimi-pure": configPath,
        "kimi-fable-advisor": configPath,
      },
      environmentLockPath: environmentPath,
      commands,
    };
    const first = await ensureCampaignProvenance(options);
    const second = await ensureCampaignProvenance(options);
    expect(second.inputHash).toBe(first.inputHash);

    await expect(
      ensureCampaignProvenance({ ...options, commands: new FakeGit(" M src/file.ts\n") }),
    ).rejects.toThrow("clean worktree");
  });
});

class FakeGit implements CommandRunner {
  constructor(private readonly status: string) {}

  async run(argv: readonly string[]): Promise<CommandResult> {
    if (argv[1] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
    return { stdout: this.status, stderr: "", exitCode: 0 };
  }

  stream(): ExecTransport {
    throw new Error("not used");
  }
}

function fixtureCampaign(): CampaignSpec {
  return {
    schemaVersion: 1,
    id: "campaign",
    manifestPath: "manifest.json",
    configs: ["glm-pure"],
    trials: 1,
    concurrency: 1,
    armOrderSeed: 1,
    limits: { costUsd: 1, wallClockMs: 1, interruptGraceMs: 1, patchBytes: 1 },
    budget: { totalUsd: 500, sunkUsd: 0 },
  };
}
