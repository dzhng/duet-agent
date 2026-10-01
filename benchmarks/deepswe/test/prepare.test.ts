import { describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";
import { assertCleanRepositoryStatus, verifyDeepSweArtifacts } from "../src/prepare.js";

describe("DeepSWE artifact identity", () => {
  testIfDocker("rejects source changes that the recorded commit cannot reproduce", () => {
    expect(() => assertCleanRepositoryStatus(" M src/example.ts\n")).toThrow(
      "must be prepared from a clean worktree",
    );
    expect(() => assertCleanRepositoryStatus("")).not.toThrow();
  });

  testIfDocker("rejects a prepared file that changed after manifest creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-artifact-"));
    const paths = ["duet", "driver", "pglite.data"];
    for (const path of paths) await writeFile(join(root, path), path);
    const identity = (path: string) => ({
      path,
      sha256: createHash("sha256").update(path).digest("hex"),
    });
    const manifestPath = join(root, "artifact-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        duetCommit: "a".repeat(40),
        duet: identity("duet"),
        driver: identity("driver"),
        runtimeAssets: [identity("pglite.data")],
      }),
    );
    await expect(verifyDeepSweArtifacts(manifestPath)).resolves.toBeDefined();
    await writeFile(join(root, "driver"), "changed");
    await expect(verifyDeepSweArtifacts(manifestPath)).rejects.toThrow(
      "Prepared artifact hash changed: driver",
    );
  });
});
