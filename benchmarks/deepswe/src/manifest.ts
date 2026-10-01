import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DeepSweTask {
  /** Stable directory name in the pinned DeepSWE task corpus. */
  taskId: string;
  /** Primary implementation language declared by DeepSWE. */
  language: string;
  /** Upstream repository whose checked-out base is present in the task image. */
  repositoryUrl: string;
  /** Repository revision the agent receives. */
  baseCommit: string;
  /** Official v1.1 agent image reference used by Pier. */
  dockerImage: string;
}

export interface DeepSweManifest {
  schemaVersion: 1;
  upstream: { repository: string; commit: string };
  pier: { version: string; repository: string; commit: string };
  selection: { corpusSize: number; size: number; seed: number; algorithm: string };
  tasks: DeepSweTask[];
}

/** Read and structurally validate the committed pilot population. */
export async function loadDeepSweManifest(path: string): Promise<DeepSweManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as DeepSweManifest;
  validateManifest(value);
  return value;
}

/**
 * Prove the pinned checkout still contains the exact task identities selected
 * for the pilot. DeepSWE remains the owner of task bodies and verifiers.
 */
export async function verifyDeepSweCheckout(
  checkoutRoot: string,
  manifest: DeepSweManifest,
): Promise<void> {
  validateManifest(manifest);
  const gitSha = (await Bun.$`git -C ${checkoutRoot} rev-parse HEAD`.text()).trim();
  if (gitSha !== manifest.upstream.commit) {
    throw new Error(`DeepSWE checkout is ${gitSha}, expected ${manifest.upstream.commit}.`);
  }

  for (const task of manifest.tasks) {
    const taskTomlPath = join(resolve(checkoutRoot), "tasks", task.taskId, "task.toml");
    const taskToml = await readFile(taskTomlPath, "utf8");
    const actual = {
      language: tomlString(taskToml, "language"),
      repositoryUrl: tomlString(taskToml, "repository_url"),
      baseCommit: tomlString(taskToml, "base_commit_hash"),
      dockerImage: tomlString(taskToml, "docker_image"),
    };
    for (const [field, expected] of Object.entries({
      language: task.language,
      repositoryUrl: task.repositoryUrl,
      baseCommit: task.baseCommit,
      dockerImage: task.dockerImage,
    })) {
      if (actual[field as keyof typeof actual] !== expected) {
        throw new Error(
          `${task.taskId} ${field} is ${actual[field as keyof typeof actual]}, expected ${expected}.`,
        );
      }
    }
  }
}

/** Re-run the documented Python population selector against the pinned corpus. */
export async function verifyDeepSweSelection(
  checkoutRoot: string,
  manifest: DeepSweManifest,
  pythonPath: string,
): Promise<void> {
  validateManifest(manifest);
  const script = [
    "import json, pathlib, random, sys",
    "root = pathlib.Path(sys.argv[1]) / 'tasks'",
    "seed, size = int(sys.argv[2]), int(sys.argv[3])",
    "task_ids = sorted(path.name for path in root.iterdir() if path.is_dir())",
    "random.Random(seed).shuffle(task_ids)",
    "print(json.dumps({'corpusSize': len(task_ids), 'taskIds': task_ids[:size]}))",
  ].join("; ");
  const child = Bun.spawn(
    [
      pythonPath,
      "-c",
      script,
      resolve(checkoutRoot),
      String(manifest.selection.seed),
      String(manifest.selection.size),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`DeepSWE population selection failed:\n${stderr}`);
  const selected = JSON.parse(stdout) as { corpusSize: number; taskIds: string[] };
  if (selected.corpusSize !== manifest.selection.corpusSize) {
    throw new Error(
      `DeepSWE corpus has ${selected.corpusSize} tasks, expected ${manifest.selection.corpusSize}.`,
    );
  }
  const expected = manifest.tasks.map((task) => task.taskId);
  if (JSON.stringify(selected.taskIds) !== JSON.stringify(expected)) {
    throw new Error("Committed DeepSWE pilot ids do not match the documented seeded selector.");
  }
}

function validateManifest(manifest: DeepSweManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported DeepSWE manifest schema.");
  if (manifest.tasks.length !== manifest.selection.size || manifest.tasks.length !== 10) {
    throw new Error("The DeepSWE pilot manifest must contain exactly ten tasks.");
  }
  const ids = manifest.tasks.map((task) => task.taskId);
  if (new Set(ids).size !== ids.length) throw new Error("DeepSWE task ids must be unique.");
  for (const task of manifest.tasks) {
    if (!/^[a-z0-9-]+$/.test(task.taskId)) throw new Error(`Unsafe task id: ${task.taskId}`);
    if (
      !task.language ||
      !task.repositoryUrl ||
      !task.baseCommit ||
      !task.dockerImage.endsWith("-v1.1")
    ) {
      throw new Error(`Incomplete DeepSWE task identity: ${task.taskId}`);
    }
  }
}

function tomlString(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name} = "([^"]+)"$`, "m"));
  if (!match?.[1]) throw new Error(`task.toml is missing ${name}.`);
  return match[1];
}
