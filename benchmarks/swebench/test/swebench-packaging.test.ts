import { afterEach, describe, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadPrebuiltDuetArtifact } from "../src/packaging.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench Duet packaging", () => {
  testIfDocker("loads the exact prebuilt worker artifact without rebuilding it", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-package-"));
    const path = join(root, "duet-linux-x64");
    await writeFile(path, "prebuilt-duet");

    expect(await loadPrebuiltDuetArtifact(path)).toEqual({
      localPath: resolve(path),
      installPath: "/opt/duet/duet",
      sha256: "5b1407ebee7b098f71f5ad498f4b33f23affd72ea55a83bcbf14870f63f59936",
      packagingMode: "compiled-linux-x64",
    });
  });
});
