import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { LocalCommandRunner, type CommandRunner } from "./container.js";

/** Linux artifact installed into every official instance image. */
export interface DuetArtifact {
  localPath: string;
  installPath: "/opt/duet/duet";
  sha256: string;
  packagingMode: "compiled-linux-x64";
}

export interface PrepareDuetArtifactOptions {
  /** Repository root containing package.json, bun.lock, and src/. */
  repoRoot: string;
  /** Durable host directory for the resulting binary. */
  outputDir: string;
  /** Injectable command boundary used by deterministic tests. */
  commands?: CommandRunner;
}

/**
 * Load a binary built into an immutable worker image instead of rebuilding it
 * independently in every sandbox.
 */
export async function loadPrebuiltDuetArtifact(localPath: string): Promise<DuetArtifact> {
  const resolvedPath = resolve(localPath);
  return {
    localPath: resolvedPath,
    installPath: "/opt/duet/duet",
    sha256: await sha256File(resolvedPath),
    packagingMode: "compiled-linux-x64",
  };
}

/**
 * Cross-compile duet for the official x86_64 images from an Apple-Silicon Mac.
 *
 * Bun resolves optional native packages for the install host by default. A
 * target-platform install in an isolated source tree is therefore required
 * before `--target=bun-linux-x64`; compiling against the Mac's node_modules
 * cannot resolve OpenTUI's Linux package.
 */
export async function prepareDuetArtifact(
  options: PrepareDuetArtifactOptions,
): Promise<DuetArtifact> {
  const commands = options.commands ?? new LocalCommandRunner();
  const buildRoot = await mkdtemp(join(tmpdir(), "duet-swebench-package-"));
  const outputDir = resolve(options.outputDir);
  const localPath = join(outputDir, "duet-linux-x64");

  try {
    await Promise.all([
      cp(join(options.repoRoot, "package.json"), join(buildRoot, "package.json")),
      cp(join(options.repoRoot, "bun.lock"), join(buildRoot, "bun.lock")),
      cp(join(options.repoRoot, "tsconfig.json"), join(buildRoot, "tsconfig.json")),
      cp(join(options.repoRoot, "src"), join(buildRoot, "src"), { recursive: true }),
    ]);
    await mkdir(outputDir, { recursive: true });

    await requireSuccess(
      commands,
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--os", "linux", "--cpu", "x64"],
      buildRoot,
    );
    await requireSuccess(
      commands,
      [
        "bun",
        "build",
        "src/cli-entry.ts",
        "--compile",
        "--target=bun-linux-x64",
        "--outfile",
        localPath,
      ],
      buildRoot,
    );

    return {
      localPath,
      installPath: "/opt/duet/duet",
      sha256: await sha256File(localPath),
      packagingMode: "compiled-linux-x64",
    };
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

async function requireSuccess(
  commands: CommandRunner,
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await commands.run(argv, { cwd });
  if (result.exitCode === 0) return;
  throw new Error(
    `Packaging command failed (${result.exitCode}): ${argv.join(" ")}\n${result.stderr || result.stdout}`,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
