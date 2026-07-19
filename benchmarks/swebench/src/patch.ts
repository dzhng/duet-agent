import { randomUUID } from "node:crypto";

import type { CommandResult } from "./container.js";

/** Minimal container operations required by staged-index patch handling. */
export interface PatchContainer {
  exec(
    argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ): Promise<CommandResult>;
}

/** Private Git tree representing the official image before the model runs. */
export interface PatchBaseline {
  indexPath: string;
  tree: string;
  /** Pre-existing image modifications retained for provenance, never submitted. */
  paths: string[];
}

/** Exact agent delta submitted to the official scorer. */
export interface ExtractedPatch {
  patch: string;
  bytes: number;
  paths: string[];
}

/**
 * Snapshot the official image's working tree without requiring `git status` to
 * be clean. Some official images deliberately modify build files (for example,
 * Druid pins a Maven resource bundle); resetting them changes the benchmark.
 */
export async function capturePatchBaseline(container: PatchContainer): Promise<PatchBaseline> {
  const indexPath = `/tmp/duet-index-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "read-tree", "HEAD"], env);
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const tree = (
    await requireGit(container, ["git", "-C", "/testbed", "write-tree"], env)
  ).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`Could not capture official image baseline tree: ${JSON.stringify(tree)}.`);
  }
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", "HEAD", "--"],
    env,
  );
  return { indexPath, tree, paths: splitPaths(names.stdout) };
}

/** Stage the final worktree over its captured baseline and emit only the agent delta. */
export async function extractPatch(
  container: PatchContainer,
  baseline: PatchBaseline,
  maxBytes: number,
): Promise<ExtractedPatch> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
  const env = { GIT_INDEX_FILE: baseline.indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", baseline.tree, "--"],
    env,
  );
  const diff = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--binary", "--full-index", baseline.tree, "--"],
    env,
  );
  const paths = splitPaths(names.stdout);
  const bytes = Buffer.byteLength(diff.stdout);
  if (bytes === 0) throw new Error("Rollout produced an empty patch.");
  if (bytes > maxBytes) {
    throw new Error(`Rollout patch is ${bytes} bytes, above the ${maxBytes}-byte limit.`);
  }
  assertNoHarnessPollution(paths);
  return { patch: diff.stdout, bytes, paths };
}

/** Apply a patch to the same official baseline and prove it reproduces the path set. */
export async function verifyPatchRoundTrip(
  container: PatchContainer,
  extracted: ExtractedPatch,
): Promise<void> {
  const baseline = await capturePatchBaseline(container);
  const applied = await container.exec(["git", "-C", "/testbed", "apply", "--binary", "-"], {
    stdin: extracted.patch,
  });
  if (applied.exitCode !== 0) {
    throw new Error(`Extracted patch does not apply cleanly: ${applied.stderr || applied.stdout}`);
  }
  const env = { GIT_INDEX_FILE: baseline.indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", baseline.tree, "--"],
    env,
  );
  const actual = splitPaths(names.stdout).sort();
  const expected = [...extracted.paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Round-trip paths differ: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
  const diff = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--binary", "--full-index", baseline.tree, "--"],
    env,
  );
  if (diff.stdout !== extracted.patch) {
    throw new Error("Round-trip patch bytes differ from the extracted patch.");
  }
}

function splitPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function assertNoHarnessPollution(paths: readonly string[]): void {
  const polluted = paths.filter(
    (path) => path === ".duet" || path.startsWith(".duet/") || path.startsWith("opt/duet/"),
  );
  if (polluted.length > 0) {
    throw new Error(`Patch contains harness runtime files: ${polluted.join(", ")}.`);
  }
}

async function requireGit(
  container: PatchContainer,
  argv: readonly string[],
  env: Record<string, string>,
) {
  const result = await container.exec(argv, { env });
  if (result.exitCode !== 0) {
    throw new Error(`Git command failed: ${argv.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}
