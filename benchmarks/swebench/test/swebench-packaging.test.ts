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
    await Promise.all([
      writeFile(path, "prebuilt-duet"),
      writeFile(join(root, "pglite.data"), "pglite-data"),
      writeFile(join(root, "pglite.wasm"), "pglite-wasm"),
      writeFile(join(root, "initdb.wasm"), "initdb-wasm"),
      writeFile(join(root, "vector.tar.gz"), "vector-bundle"),
    ]);

    const artifact = await loadPrebuiltDuetArtifact(path);
    expect(artifact).toMatchObject({
      localPath: resolve(path),
      installPath: "/opt/duet/duet",
      sha256: "5b1407ebee7b098f71f5ad498f4b33f23affd72ea55a83bcbf14870f63f59936",
      packagingMode: "compiled-linux-x64",
    });
    expect(artifact.runtimeAssets).toEqual([
      {
        name: "pglite.data",
        localPath: resolve(root, "pglite.data"),
        installPath: "/opt/duet/pglite.data",
        sha256: "1e080a964119f869f42c0c02ac868913f482a887724afa0c821b1a02da1c8447",
      },
      {
        name: "pglite.wasm",
        localPath: resolve(root, "pglite.wasm"),
        installPath: "/opt/duet/pglite.wasm",
        sha256: "a6ca6c3ae6c10f6eb0b1e6d511c7f7ce906d93d53535b53d2e0b245ba8870399",
      },
      {
        name: "initdb.wasm",
        localPath: resolve(root, "initdb.wasm"),
        installPath: "/opt/duet/initdb.wasm",
        sha256: "ed4af33b09e17be37145d476f812121d5e225393f54970d01aa6d26fb539b877",
      },
      {
        name: "vector.tar.gz",
        localPath: resolve(root, "vector.tar.gz"),
        installPath: "/opt/duet/vector.tar.gz",
        sha256: "e9b62d5569b52f792a3ef57c5be23ee638036791344acecafe27b069744f06ea",
      },
    ]);
  });
});
