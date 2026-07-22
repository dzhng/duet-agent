import * as fileSystem from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect } from "bun:test";

import { discoverMemoryStores } from "../src/memory/store/discovery.js";
import { listStore, writeEntry, type MemoryEntryInput } from "../src/memory/store/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("memory-store discovery", () => {
  testIfDocker("walks a nested tree nearest-first so the nearest duplicate slug wins", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-discovery-"));
    const project = join(root, "project");
    const packageDir = join(project, "packages", "app");
    const nearest = join(project, "packages", ".duet", "memories");
    const sameLevelAgents = join(project, ".agents", "memories");
    const sameLevelClaude = join(project, ".claude", "memories");
    try {
      await fileSystem.mkdir(packageDir, { recursive: true });
      await writeEntry(nearest, entry("mem_nearest", "Nearest content.\n"));
      await writeEntry(sameLevelAgents, entry("mem_far", "Far content.\n"));
      await writeEntry(sameLevelClaude, {
        ...entry("mem_other", "Other content.\n"),
        slug: "other",
      });

      const stores = await discoverMemoryStores(packageDir);
      expect(stores).toEqual([nearest, sameLevelAgents, sameLevelClaude]);

      const inherited = (await Promise.all(stores.map(listStore))).flat();
      expect(inherited.find((memory) => memory.slug === "shared")?.id).toBe("mem_nearest");
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("does not discover a memory store rooted at $HOME", async () => {
    const home = homedir();
    await fileSystem.mkdir(home, { recursive: true });
    const project = await fileSystem.mkdtemp(join(home, "duet-memory-home-walk-"));
    const cwd = join(project, "nested");
    const projectStore = join(project, ".agents", "memories");
    const homeStore = join(home, ".agents", "memories");
    try {
      await fileSystem.mkdir(cwd, { recursive: true });
      await writeEntry(projectStore, entry("mem_project", "Project memory.\n"));
      await writeEntry(homeStore, { ...entry("mem_home", "Home memory.\n"), slug: "home" });

      expect(await discoverMemoryStores(cwd)).toEqual([projectStore]);
    } finally {
      await fileSystem.rm(project, { recursive: true, force: true });
      await fileSystem.rm(join(home, ".agents"), { recursive: true, force: true });
    }
  });
});

function entry(id: string, content: string): MemoryEntryInput {
  return {
    slug: "shared",
    version: 1,
    id,
    kind: "note",
    createdAt: 1_784_737_200_200,
    content,
  };
}
