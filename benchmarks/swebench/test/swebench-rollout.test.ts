import { afterEach, describe, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PGLITE_RUNTIME_ASSET_NAMES } from "../../../src/memory/pglite.js";
import type { CommandResult } from "../src/container.js";
import type { ExecTransport } from "../src/duet-client.js";
import type { DuetArtifact } from "../src/packaging.js";
import { SWEBENCH_SYSTEM_PROMPT } from "../src/prompt.js";
import { runRollout, type RolloutContainer } from "../src/rollout.js";
import { runContainerSmoke } from "../src/smoke.js";
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
      let launchedImage: string | undefined;
      const result = await runRollout(
        {
          runsRoot: root,
          artifact: fixtureArtifact(),
          providerEnv: { AI_GATEWAY_API_KEY: "secret" },
          containerFactory: (_name, image) => {
            launchedImage = image;
            return container;
          },
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
          imageId: `sha256:${"c".repeat(64)}`,
          configPath,
          configSha256: "b".repeat(64),
          limits: { costUsd: 1, wallClockMs: 1000, interruptGraceMs: 10, patchBytes: 1000 },
        },
      );

      expect(result.status.phase).toBe("completed");
      expect(launchedImage).toBe(`sha256:${"c".repeat(64)}`);
      expect(result.attempt.spec).toMatchObject({
        image: "official/image",
        imageId: `sha256:${"c".repeat(64)}`,
      });
      expect(container.stopped).toBe(true);
      expect(container.copies).toEqual([
        ["/host/duet", "/opt/duet/duet"],
        ["/host/pglite.data", "/opt/duet/pglite.data"],
        ["/host/pglite.wasm", "/opt/duet/pglite.wasm"],
        ["/host/initdb.wasm", "/opt/duet/initdb.wasm"],
        ["/host/vector.tar.gz", "/opt/duet/vector.tar.gz"],
        [configPath, "/opt/duet/home/.duet/models.json"],
      ]);
      expect(container.rpcOptions?.cwd).toBe("/testbed");
      expect(container.rpcArgv).toEqual([
        "/opt/duet/duet",
        "--rpc",
        "--model",
        "swebench",
        "--session",
        "swebench",
        "--workdir",
        "/testbed",
        "--system-prompt",
        SWEBENCH_SYSTEM_PROMPT,
      ]);
      expect(container.rpcOptions?.env).toEqual({
        AI_GATEWAY_API_KEY: "secret",
        HOME: "/opt/duet/home",
        CI: "1",
        PAGER: "cat",
        GIT_PAGER: "cat",
        BAT_PAGER: "cat",
        TERM: "dumb",
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
        artifact: fixtureArtifact(),
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
        imageId: "sha256:official",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result.status).toMatchObject({ phase: "failed", failureKind: "infra" });
    expect(container.stopped).toBe(true);
  });

  testIfDocker("records an RPC process exit as infrastructure failure", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-rollout-exit-"));
    const configPath = join(root, "models.json");
    await writeFile(configPath, "{}\n");
    const container = new FakeRolloutContainer(false, ["src/a.ts"], "", true);
    const result = await runRollout(
      {
        runsRoot: root,
        artifact: fixtureArtifact(),
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
        imageId: "sha256:official",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result.status).toMatchObject({
      phase: "failed",
      failureKind: "infra",
      terminalType: "killed",
    });
    expect(container.stopped).toBe(true);
  });

  testIfDocker("exports the agent's complete patch including test paths", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-rollout-test-path-"));
    const configPath = join(root, "models.json");
    await writeFile(configPath, "{}\n");
    const container = new FakeRolloutContainer(false, ["src/a.ts", "tests/a.test.ts"]);
    const result = await runRollout(
      {
        runsRoot: root,
        artifact: fixtureArtifact(),
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
        imageId: "sha256:official",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result.status).toMatchObject({ phase: "completed", terminalType: "complete" });
    expect(
      JSON.parse(await readFile(join(result.attempt.directory, "patch-paths.json"), "utf8")),
    ).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(container.stopped).toBe(true);
  });

  testIfDocker("completes an empty patch so the scorer can count the model outcome", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-rollout-empty-"));
    const configPath = join(root, "models.json");
    await writeFile(configPath, "{}\n");
    const container = new FakeRolloutContainer(false, [], "");
    const result = await runRollout(
      {
        runsRoot: root,
        artifact: fixtureArtifact(),
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
        imageId: "sha256:official",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result.status).toMatchObject({ phase: "completed", terminalType: "complete" });
    expect(await readFile(join(result.attempt.directory, "patch.diff"), "utf8")).toBe("");
    expect(container.stopped).toBe(true);
  });

  testIfDocker("smoke proves a pure one-file patch in a fresh container", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-smoke-"));
    const configPath = join(root, "models.json");
    await writeFile(configPath, "{}\n");
    const sentinel = "duet swebench smoke org__repo-1\n";
    const patch = [
      "diff --git a/duet-swebench-smoke.txt b/duet-swebench-smoke.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/duet-swebench-smoke.txt",
      "@@ -0,0 +1 @@",
      "+duet swebench smoke org__repo-1",
      "",
    ].join("\n");
    const primary = new FakeSmokeContainer(patch, sentinel, true);
    const roundTrip = new FakeSmokeContainer(patch, sentinel, false);
    const containers = [primary, roundTrip];

    const result = await runContainerSmoke(
      {
        runsRoot: root,
        artifact: fixtureArtifact(),
        providerEnv: {},
        containerFactory: () => containers.shift()!,
      },
      {
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
          problemStatement: "Original issue is replaced by the smoke task.",
        },
        image: "official/image",
        configPath,
        configSha256: "b".repeat(64),
        limits: { costUsd: 1, wallClockMs: 1000, patchBytes: 1000 },
      },
    );

    expect(result).toMatchObject({
      instanceId: "org__repo-1",
      terminalType: "complete",
      costUsd: 0.3,
      patchBytes: Buffer.byteLength(patch),
      patchPaths: ["duet-swebench-smoke.txt"],
    });
    expect(containers).toEqual([]);
    expect(primary.stopped).toBe(true);
    expect(roundTrip.stopped).toBe(true);
  });
});

class FakeRolloutContainer implements RolloutContainer {
  readonly copies: string[][] = [];
  stopped = false;
  rpcArgv?: readonly string[];
  rpcOptions?: { cwd?: string; env?: Record<string, string> };
  private gitCall = 0;

  constructor(
    private readonly failStart: boolean,
    private readonly patchPaths: readonly string[] = ["src/a.ts"],
    private readonly patch = "diff --git a/src/a.ts b/src/a.ts\n+fixed\n",
    private readonly exitBeforeTerminal = false,
  ) {}

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
    if (this.gitCall === 6) return ok(`${this.patchPaths.join("\0")}\0`);
    if (this.gitCall === 7) return ok(this.patch);
    return ok("");
  }

  execStream(
    argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): ExecTransport {
    this.rpcArgv = argv;
    this.rpcOptions = options;
    return {
      stdin: { write: () => {} },
      stdoutLines: lines(
        this.exitBeforeTerminal
          ? ['{"type":"system","level":"error","message":"fatal startup error"}']
          : [
              '{"type":"turn_started","state":{"status":"running","mode":"agent","agent":{"status":"running","messages":[]}}}',
              '{"type":"complete","status":"completed","result":"done","state":{"status":"completed","mode":"agent","agent":{"status":"completed","messages":[]}},"turnUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"usageByModel":[{"model":"model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}}}],"lastMessageUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"effectiveContextWindow":1000,"contextWindowUsage":{"systemPrompt":1,"messages":1,"localMemory":0,"globalMemory":0}}',
            ],
      ),
      kill: () => {},
      exited: Promise.resolve({ code: 0, signal: null }),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeSmokeContainer implements RolloutContainer {
  stopped = false;

  constructor(
    private readonly patch: string,
    private readonly sentinel: string,
    private readonly servesRpc: boolean,
  ) {}

  async start(): Promise<void> {}

  async cpIn(): Promise<void> {}

  async exec(argv: readonly string[]): Promise<CommandResult> {
    if (argv[0] === "cat") return ok(this.sentinel);
    if (argv[0] !== "git") return ok("");
    if (argv.includes("write-tree")) return ok(`${"c".repeat(40)}\n`);
    if (argv.includes("--name-only")) {
      return ok(argv.includes("HEAD") ? "" : "duet-swebench-smoke.txt\0");
    }
    if (argv.includes("--binary")) return ok(this.patch);
    return ok("");
  }

  execStream(): ExecTransport {
    if (!this.servesRpc) throw new Error("Round-trip container must not start RPC.");
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
    if (this.stopped) throw new Error("Container stopped twice.");
    this.stopped = true;
  }
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fixtureArtifact(): DuetArtifact {
  return {
    localPath: "/host/duet",
    installPath: "/opt/duet/duet",
    sha256: "a".repeat(64),
    runtimeAssets: PGLITE_RUNTIME_ASSET_NAMES.map((name) => ({
      name,
      localPath: `/host/${name}`,
      installPath: `/opt/duet/${name}` as const,
      sha256: "c".repeat(64),
    })),
    packagingMode: "compiled-linux-x64",
  };
}

async function* lines(values: readonly string[]): AsyncGenerator<string> {
  yield* values;
}
