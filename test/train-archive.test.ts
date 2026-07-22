import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "bun:test";

import { MemoryDb } from "../src/cli/memory-db.js";
import { collectArchiveFiles, removeArchive, writeArchive } from "../src/train/archive.js";
import { testIfDocker } from "./helpers/docker-only.js";
import type { TrainManifest } from "../src/train/types.js";

/**
 * Archive paths are rooted at `os.homedir()`, which on POSIX resolves
 * from `$HOME` at call time — so pointing HOME at a tmpdir sandboxes
 * every archive write/remove these tests perform.
 */
let fakeHome: string;
let realHome: string | undefined;

beforeEach(async () => {
  realHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), "duet-train-archive-home-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (realHome !== undefined) process.env.HOME = realHome;
  await rm(fakeHome, { recursive: true, force: true });
});

function archivePath(memoryId: string): string {
  return join(homedir(), ".duet", "train", memoryId);
}

async function makeCorpus(): Promise<string> {
  const corpus = await mkdtemp(join(tmpdir(), "duet-train-archive-corpus-"));
  await writeFile(join(corpus, "notes.md"), "# Notes\nalpha beta\n");
  await mkdir(join(corpus, "sub"), { recursive: true });
  await writeFile(join(corpus, "sub", "data.csv"), "a,b\n1,2\n");
  // All of these must be skipped by the walker.
  await writeFile(join(corpus, ".env"), "SECRET=1\n");
  await writeFile(join(corpus, ".duet-train.json"), `{"headline":"x"}`);
  await mkdir(join(corpus, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(corpus, "node_modules", "pkg", "index.js"), "x");
  return corpus;
}

describe("collectArchiveFiles", () => {
  testIfDocker(
    "walks the corpus, skipping dotfiles, node_modules, and the handoff file",
    async () => {
      const corpus = await makeCorpus();
      try {
        const files = await collectArchiveFiles(corpus);
        expect(files.map((f) => f.relPath)).toEqual(["notes.md", "sub/data.csv"]);
        // sha256 of the actual bytes, byte sizes from disk.
        const notes = files[0]!;
        expect(notes.bytes).toBe(Buffer.byteLength("# Notes\nalpha beta\n"));
        expect(notes.sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await rm(corpus, { recursive: true, force: true });
      }
    },
  );
});

describe("writeArchive / removeArchive", () => {
  testIfDocker(
    "copies files + manifest under ~/.duet/train/<id> and removes them cleanly",
    async () => {
      const corpus = await makeCorpus();
      try {
        const memoryId = "mem_test-archive-1";
        const files = await collectArchiveFiles(corpus);
        const manifest: TrainManifest = {
          memoryId,
          slug: "test-corpus",
          createdAt: 1_700_000_000_000,
          sourceFolder: corpus,
          model: "test-model",
          headline: "Test corpus",
          files: files.map((f) => ({ relPath: f.relPath, bytes: f.bytes, sha256: f.sha256 })),
        };

        const root = await writeArchive({ memoryId, files, manifest });
        expect(root).toBe(archivePath(memoryId));

        const copied = await readFile(join(root, "files", "sub", "data.csv"), "utf8");
        expect(copied).toBe("a,b\n1,2\n");
        const parsed = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
        expect(parsed.headline).toBe("Test corpus");

        await removeArchive(memoryId);
        expect(await stat(root).catch(() => undefined)).toBeUndefined();
        // Removing an id with no archive is a no-op, not an error.
        await removeArchive("mem_never-existed");
      } finally {
        await rm(corpus, { recursive: true, force: true });
      }
    },
  );
});

describe("MemoryDb.delete", () => {
  testIfDocker("removes the train archive alongside the observation row", async () => {
    const dbDir = await mkdtemp(join(tmpdir(), "duet-train-archive-db-"));
    const db = await MemoryDb.open(join(dbDir, "memory.db"));
    try {
      // The row itself doesn't need to exist for the lifecycle contract:
      // delete(id) must clear ~/.duet/train/<id>/ whether or not the DB
      // row is present (DELETE is a no-op on a missing row).
      const memoryId = "mem_test-archive-2";
      const root = archivePath(memoryId);
      await mkdir(join(root, "files"), { recursive: true });
      await writeFile(join(root, "manifest.json"), "{}");

      await db.delete(memoryId);

      expect(await stat(root).catch(() => undefined)).toBeUndefined();
    } finally {
      await db.close();
      await rm(dbDir, { recursive: true, force: true });
    }
  });
});

describe("archive id containment", () => {
  testIfDocker("refuses to remove archives outside the archive root", async () => {
    const outside = join(fakeHome, "important");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "keep");
    await expect(removeArchive("../../important")).rejects.toThrow("safe path segment");
    await expect(removeArchive("..")).rejects.toThrow("safe path segment");
    expect((await stat(join(outside, "keep.txt"))).isFile()).toBe(true);
  });
});
