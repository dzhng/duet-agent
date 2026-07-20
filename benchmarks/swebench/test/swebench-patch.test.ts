import { describe, expect, test } from "bun:test";

import { ContainerHandle, type CommandResult, type CommandRunner } from "../src/container.js";
import type { ExecTransport } from "../src/duet-client.js";
import { capturePatchBaseline, extractPatch } from "../src/patch.js";

class ScriptedCommands implements CommandRunner {
  readonly calls: string[][] = [];
  constructor(readonly results: CommandResult[]) {}

  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push([...argv]);
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
    });

    const gitCalls = commands.calls.filter((argv) => argv[0] === "docker" && argv[1] === "exec");
    expect(gitCalls.map((argv) => argv.slice(-6))).toContainEqual([
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      tree,
      "--",
    ]);
    const privateIndexArgs = gitCalls.flatMap((argv) =>
      argv.filter((arg) => arg.startsWith("GIT_INDEX_FILE=")),
    );
    expect(privateIndexArgs.length).toBeGreaterThan(0);
    expect(privateIndexArgs.every((value) => value === privateIndexArgs[0])).toBe(true);
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

    expect(extracted).toEqual({ patch: "", bytes: 0, paths: [] });
  });
});
