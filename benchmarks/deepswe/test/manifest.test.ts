import { describe, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";
import {
  loadDeepSweManifest,
  verifyDeepSweCheckout,
  type DeepSweManifest,
} from "../src/manifest.js";

const MANIFEST_PATH = join(import.meta.dir, "../manifests/pilot-10-seed-0.json");

describe("DeepSWE pilot manifest", () => {
  testIfDocker("pins ten distinct official v1.1 task identities", async () => {
    const manifest = await loadDeepSweManifest(MANIFEST_PATH);
    expect(manifest.tasks).toHaveLength(10);
    expect(new Set(manifest.tasks.map((task) => task.taskId)).size).toBe(10);
    expect(new Set(manifest.tasks.map((task) => task.language))).toEqual(
      new Set(["typescript", "javascript", "go", "python", "rust"]),
    );
    expect(manifest.tasks.every((task) => task.dockerImage.endsWith("-v1.1"))).toBe(true);
  });

  testIfDocker("verifies task values rather than only directory counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-manifest-"));
    const source = await loadDeepSweManifest(MANIFEST_PATH);
    const manifest: DeepSweManifest = {
      ...source,
      tasks: source.tasks.map((task) => ({ ...task })),
    };
    await Bun.$`git -C ${root} init -q`;
    await Bun.$`git -C ${root} config user.email test@example.com`;
    await Bun.$`git -C ${root} config user.name Test`;
    for (const task of manifest.tasks) {
      const taskRoot = join(root, "tasks", task.taskId);
      await mkdir(taskRoot, { recursive: true });
      await writeFile(
        join(taskRoot, "task.toml"),
        [
          `[metadata]`,
          `language = "${task.language}"`,
          `repository_url = "${task.repositoryUrl}"`,
          `base_commit_hash = "${task.baseCommit}"`,
          `[environment]`,
          `docker_image = "${task.dockerImage}"`,
          "",
        ].join("\n"),
      );
    }
    await Bun.$`git -C ${root} add .`;
    await Bun.$`git -C ${root} commit -qm fixture`;
    manifest.upstream = {
      ...manifest.upstream,
      commit: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
    };

    await expect(verifyDeepSweCheckout(root, manifest)).resolves.toBeUndefined();
    const first = manifest.tasks[0]!;
    await writeFile(
      join(root, "tasks", first.taskId, "task.toml"),
      [
        `[metadata]`,
        `language = "wrong"`,
        `repository_url = "${first.repositoryUrl}"`,
        `base_commit_hash = "${first.baseCommit}"`,
        `[environment]`,
        `docker_image = "${first.dockerImage}"`,
        "",
      ].join("\n"),
    );
    await expect(verifyDeepSweCheckout(root, manifest)).rejects.toThrow(
      `${first.taskId} language is wrong`,
    );
  });
});
