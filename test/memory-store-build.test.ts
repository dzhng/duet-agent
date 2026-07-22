import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect } from "bun:test";

import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker(
  "the built memory-store subpath imports only node builtins",
  async () => {
    const build = Bun.spawn(["bun", "run", "build"], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(exitCode, stderr).toBe(0);

    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dir, "../package.json"), "utf8"),
    ) as {
      exports: Record<string, { import: string; types: string }>;
    };
    const memoryStoreExport = packageJson.exports["./memory-store"];
    expect(memoryStoreExport).toBeDefined();
    if (!memoryStoreExport) throw new Error("package.json is missing the ./memory-store export");

    const chunk = await readFile(resolve(import.meta.dir, "..", memoryStoreExport.import), "utf8");
    const moduleSpecifiers = Array.from(
      chunk.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g),
      (match) => match[1]!,
    );
    expect(moduleSpecifiers.length).toBeGreaterThan(0);
    expect(moduleSpecifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  },
  30_000,
);
