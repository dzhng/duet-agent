import { describe, expect, test } from "bun:test";

import { ContainerHandle, type CommandResult, type CommandRunner } from "../src/container.js";
import type { ExecTransport } from "../src/duet-client.js";
import { capturePatchBaseline, extractPatch } from "../src/patch.js";

class ScriptedCommands implements CommandRunner {
  readonly calls: string[][] = [];
  readonly environments: NodeJS.ProcessEnv[] = [];
  constructor(readonly results: CommandResult[]) {}

  async run(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<CommandResult> {
    this.calls.push([...argv]);
    if (options?.env) this.environments.push(options.env);
    return this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  stream(): ExecTransport {
    throw new Error("stream is not used by patch extraction tests");
  }
}

describe("SWE-bench patch extraction", () => {
  test("subtracts an intentionally dirty official baseline and keeps the exact agent delta", async () => {
    const tree = "a".repeat(40);
    const patch = "diff --git a/src/a.ts b/src/a.ts\nnew content\n";
    const commands = new ScriptedCommands([
      { stdout: "container-id", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: `${tree}\n`, stderr: "", exitCode: 0 },
      { stdout: "pom.xml\0", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "src/a.ts\0new file.txt\0", stderr: "", exitCode: 0 },
      { stdout: patch, stderr: "", exitCode: 0 },
    ]);
    const container = new ContainerHandle("patch-test", "official/image", commands);
    await container.start();
    const baseline = await capturePatchBaseline(container);
    expect(baseline.tree).toBe(tree);
    expect(baseline.paths).toEqual(["pom.xml"]);

    const extracted = await extractPatch(container, baseline, 10_000);
    expect(extracted).toEqual({
      patch,
      bytes: Buffer.byteLength(patch),
      paths: ["src/a.ts", "new file.txt"],
      excludedPaths: [],
    });

    const gitCalls = commands.calls.filter((argv) => argv[0] === "docker" && argv[1] === "exec");
    expect(gitCalls.map((argv) => argv.slice(-8))).toContainEqual([
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      tree,
      "--",
      "src/a.ts",
      "new file.txt",
    ]);
    const privateIndexes = commands.environments
      .map((environment) => environment.GIT_INDEX_FILE)
      .filter((value): value is string => value !== undefined);
    expect(privateIndexes.length).toBeGreaterThan(0);
    expect(privateIndexes.every((value) => value === privateIndexes[0])).toBe(true);
  });

  test("rejects an invalid baseline tree instead of accepting indirect evidence", async () => {
    const commands = new ScriptedCommands([
      { stdout: "container-id", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "not-a-tree\n", stderr: "", exitCode: 0 },
    ]);
    const container = new ContainerHandle("bad-tree", "official/image", commands);
    await container.start();
    await expect(capturePatchBaseline(container)).rejects.toThrow("not-a-tree");
  });

  test("preserves an empty model patch as a scoreable outcome", async () => {
    const tree = "a".repeat(40);
    const commands = new ScriptedCommands([
      { stdout: "container-id", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: `${tree}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);
    const container = new ContainerHandle("empty-patch-test", "official/image", commands);
    await container.start();

    const extracted = await extractPatch(container, await capturePatchBaseline(container), 10_000);

    expect(extracted).toEqual({ patch: "", bytes: 0, paths: [], excludedPaths: [] });
  });

  test("keeps production changes while excluding test and runtime paths from scoring", async () => {
    const tree = "a".repeat(40);
    const patch = "diff --git a/src/a.ts b/src/a.ts\n+fixed\n";
    const commands = new ScriptedCommands([
      { stdout: "container-id", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: `${tree}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      {
        stdout: "src/a.ts\0tests/a.test.ts\0.duet/session.json\0",
        stderr: "",
        exitCode: 0,
      },
      { stdout: patch, stderr: "", exitCode: 0 },
    ]);
    const container = new ContainerHandle("mixed-patch-test", "official/image", commands);
    await container.start();

    const extracted = await extractPatch(container, await capturePatchBaseline(container), 10_000);

    expect(extracted).toEqual({
      patch,
      bytes: Buffer.byteLength(patch),
      paths: ["src/a.ts"],
      excludedPaths: ["tests/a.test.ts", ".duet/session.json"],
    });
    const diffCall = commands.calls.find(
      (argv) => argv.includes("--binary") && argv.includes("--full-index"),
    );
    expect(diffCall?.at(-1)).toBe("src/a.ts");
    expect(diffCall).not.toContain("tests/a.test.ts");
    expect(diffCall).not.toContain(".duet/session.json");
  });

  test("turns test-only work into an empty scoreable prediction without diffing it", async () => {
    const tree = "a".repeat(40);
    const commands = new ScriptedCommands([
      { stdout: "container-id", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: `${tree}\n`, stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "tests/a.test.ts\0", stderr: "", exitCode: 0 },
    ]);
    const container = new ContainerHandle("test-only-patch", "official/image", commands);
    await container.start();

    const extracted = await extractPatch(container, await capturePatchBaseline(container), 10_000);

    expect(extracted).toEqual({
      patch: "",
      bytes: 0,
      paths: [],
      excludedPaths: ["tests/a.test.ts"],
    });
    expect(commands.calls.some((argv) => argv.includes("--binary"))).toBe(false);
  });
});
