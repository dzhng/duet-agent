import { afterEach, describe, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CommandResult } from "../benchmarks/swebench/src/container.js";
import type { ExecTransport } from "../benchmarks/swebench/src/duet-client.js";
import { runRollout, type RolloutContainer } from "../benchmarks/swebench/src/rollout.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench rollout pipeline", () => {
  testIfDocker(
    "installs the selected render, captures evidence, and always tears down",
    async () => {
      root = await mkdtemp(join(tmpdir(), "duet-swebench-rollout-"));
      const configPath = join(root, "models.json");
      await writeFile(configPath, "{}\n");
      const container = new FakeRolloutContainer(false);
      const result = await runRollout(
        {
          runsRoot: root,
          artifact: {
            localPath: "/host/duet",
            installPath: "/opt/duet/duet",
            sha256: "a".repeat(64),
            packagingMode: "compiled-linux-x64",
          },
          providerEnv: { AI_GATEWAY_API_KEY: "secret" },
          containerFactory: () => container,
        },
        {
          campaignId: "test-campaign",
          config: "glm-pure",
          entry: {
            instanceId: "org__repo-1",
            language: "Go",
            repo: "org/repo",
            baseCommit: "base",
          },
          datasetRow: {
            instanceId: "org__repo-1",
            repo: "org/repo",
            baseCommit: "base",
            problemStatement: "Fix the production implementation.",
          },
          trial: 1,
          image: "official/image",
          configPath,
          configSha256: "b".repeat(64),
          limits: { costUsd: 1, wallClockMs: 1000, interruptGraceMs: 10, patchBytes: 1000 },
        },
      );

      expect(result.status.phase).toBe("completed");
      expect(container.stopped).toBe(true);
      expect(container.copies).toEqual([
        ["/host/duet", "/opt/duet/duet"],
        [configPath, "/opt/duet/home/.duet/models.json"],
      ]);
      expect(container.rpcOptions?.cwd).toBe("/testbed");
      expect(container.rpcOptions?.env).toEqual({
        HOME: "/opt/duet/home",
        AI_GATEWAY_API_KEY: "secret",
      });
      expect(await readFile(join(result.attempt.directory, "patch.diff"), "utf8")).toContain(
        "src/a.ts",
      );
    },
  );

  testIfDocker("records startup failure and still stops the owned container", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-rollout-fail-"));
    const configPath = join(root, "models.json");
    await writeFile(configPath, "{}\n");
    const container = new FakeRolloutContainer(true);
    const result = await runRollout(
      {
        runsRoot: root,
        artifact: {
          localPath: "/host/duet",
          installPath: "/opt/duet/duet",
          sha256: "a".repeat(64),
          packagingMode: "compiled-linux-x64",
        },
        providerEnv: {},
        containerFactory: () => container,
      },
      {
        campaignId: "test-campaign",
        config: "glm-pure",
        entry: {
          instanceId: "org__repo-1",
          language: "Go",
          repo: "org/repo",
          baseCommit: "base",
        },
        datasetRow: {
          instanceId: "org__repo-1",
          repo: "org/repo",
          baseCommit: "base",
          problemStatement: "Fix it.",
        },
        trial: 1,
        image: "official/image",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result.status).toMatchObject({ phase: "failed", failureKind: "infra" });
    expect(container.stopped).toBe(true);
  });
});

class FakeRolloutContainer implements RolloutContainer {
  readonly copies: string[][] = [];
  stopped = false;
  rpcOptions?: { cwd?: string; env?: Record<string, string> };
  private gitCall = 0;

  constructor(private readonly failStart: boolean) {}

  async start(): Promise<void> {
    if (this.failStart) throw new Error("start failed");
  }

  async cpIn(localPath: string, containerPath: string): Promise<void> {
    this.copies.push([localPath, containerPath]);
  }

  async exec(argv: readonly string[]): Promise<CommandResult> {
    if (argv[0] !== "git") return ok("");
    this.gitCall += 1;
    if (this.gitCall === 3) return ok(`${"c".repeat(40)}\n`);
    if (this.gitCall === 4) return ok("");
    if (this.gitCall === 6) return ok("src/a.ts\0");
    if (this.gitCall === 7) return ok("diff --git a/src/a.ts b/src/a.ts\n+fixed\n");
    return ok("");
  }

  execStream(
    _argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): ExecTransport {
    this.rpcOptions = options;
    return {
      stdin: { write: () => {} },
      stdoutLines: lines([
        '{"type":"turn_started","state":{"status":"running","mode":"agent","agent":{"status":"running","messages":[]}}}',
        '{"type":"complete","status":"completed","result":"done","state":{"status":"completed","mode":"agent","agent":{"status":"completed","messages":[]}},"turnUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"usageByModel":[{"model":"model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}}}],"lastMessageUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"effectiveContextWindow":1000,"contextWindowUsage":{"systemPrompt":1,"messages":1,"localMemory":0,"globalMemory":0}}',
      ]),
      kill: () => {},
      exited: Promise.resolve({ code: 0, signal: null }),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

async function* lines(values: readonly string[]): AsyncGenerator<string> {
  yield* values;
}
