import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { LocalCommandRunner } from "../../shared/command-runner.js";
import { prepareDuetArtifact } from "../../shared/duet-packaging.js";

export interface DeepSweArtifactManifest {
  schemaVersion: 1;
  duetCommit: string;
  duet: ArtifactFile;
  driver: ArtifactFile;
  runtimeAssets: ArtifactFile[];
}

export interface ArtifactFile {
  /** Path relative to the artifact manifest directory. */
  path: string;
  sha256: string;
}

/** Build the immutable Linux payload uploaded by the Pier agent adapter. */
export async function prepareDeepSweArtifacts(
  repoRoot: string,
  outputDir: string,
): Promise<DeepSweArtifactManifest> {
  const resolvedRoot = resolve(repoRoot);
  const resolvedOutput = resolve(outputDir);
  const commands = new LocalCommandRunner();
  const status = await commands.run(["git", "status", "--porcelain", "--untracked-files=all"], {
    cwd: resolvedRoot,
  });
  if (status.exitCode !== 0) {
    throw new Error(`Failed to inspect repository state:\n${status.stderr || status.stdout}`);
  }
  assertCleanRepositoryStatus(status.stdout);
  await mkdir(resolvedOutput, { recursive: true });
  const artifact = await prepareDuetArtifact({
    repoRoot: resolvedRoot,
    outputDir: resolvedOutput,
  });
  const driverPath = join(resolvedOutput, "deepswe-agent-driver-linux-x64");
  const compile = await commands.run(
    [
      "bun",
      "build",
      join(resolvedRoot, "benchmarks", "deepswe", "src", "agent-driver.ts"),
      "--compile",
      "--target=bun-linux-x64",
      "--outfile",
      driverPath,
    ],
    { cwd: resolvedRoot },
  );
  if (compile.exitCode !== 0) {
    throw new Error(`Failed to compile DeepSWE agent driver:\n${compile.stderr || compile.stdout}`);
  }

  const manifest: DeepSweArtifactManifest = {
    schemaVersion: 1,
    duetCommit: (
      await commands.run(["git", "rev-parse", "HEAD"], { cwd: resolvedRoot })
    ).stdout.trim(),
    duet: await fileIdentity(artifact.localPath, resolvedOutput),
    driver: await fileIdentity(driverPath, resolvedOutput),
    runtimeAssets: await Promise.all(
      artifact.runtimeAssets.map((asset) => fileIdentity(asset.localPath, resolvedOutput)),
    ),
  };
  await writeFile(
    join(resolvedOutput, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** Reject source that cannot be reconstructed from the recorded commit. */
export function assertCleanRepositoryStatus(status: string): void {
  if (status.trim()) {
    throw new Error("DeepSWE artifacts must be prepared from a clean worktree.");
  }
}

/** Re-hash every prepared file before a job is allowed to start. */
export async function verifyDeepSweArtifacts(
  manifestPath: string,
): Promise<DeepSweArtifactManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DeepSweArtifactManifest;
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported DeepSWE artifact manifest.");
  const root = dirname(resolve(manifestPath));
  for (const file of [manifest.duet, manifest.driver, ...manifest.runtimeAssets]) {
    const actual = await fileIdentity(join(root, file.path), root);
    if (actual.sha256 !== file.sha256) {
      throw new Error(`Prepared artifact hash changed: ${file.path}.`);
    }
  }
  return manifest;
}

async function fileIdentity(path: string, root: string): Promise<ArtifactFile> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path: relative(root, path), sha256: hash.digest("hex") };
}
