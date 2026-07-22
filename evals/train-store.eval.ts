import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { describe, expect } from "bun:test";

import { runTrainCommand } from "../src/cli/train.js";
import { parseMemoryFile } from "../src/memory/store/index.js";
import { archivedFilePath, readArchiveManifest, removeArchive } from "../src/train/archive.js";
import type { TrainListEntry } from "../src/train/types.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { bufferStream } from "./helpers/train.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const fixtureDir = path.join(import.meta.dir, "fixtures", "train-corpus-htmx");
const slug = "htmx-store-eval";

type TrainListEntryJson = Omit<TrainListEntry, "createdAt"> & { createdAt: string };

describe("train markdown store", () => {
  testIfDocker(
    "synthesizes grounded training into a discoverable private-archive-backed store entry",
    async () => {
      const treeRoot = await mkdtemp(path.join(tmpdir(), "duet-train-store-eval-"));
      const corpusDir = path.join(treeRoot, "corpus");
      const storeDir = path.join(treeRoot, ".agents", "memories");
      const stdout = bufferStream();
      const stderr = bufferStream();
      let archiveId: string | undefined;

      try {
        await mkdir(path.join(treeRoot, ".agents"), { recursive: true });
        await cp(fixtureDir, corpusDir, { recursive: true });

        // Falsification (2026-07-23): redirecting runStoreTrain's writeEntry
        // to a sibling directory made this eval fail at the target memoryPath
        // with ENOENT after a successful real synthesis.
        await runTrainCommand([corpusDir, "--slug", slug, "--store", storeDir, "--model", model], {
          stdout: stdout.stream,
          stderr: stderr.stream,
          cwd: corpusDir,
        });

        expect(existsSync(path.join(corpusDir, ".duet-train.json"))).toBe(false);

        const memoryPath = path.join(storeDir, `${slug}.md`);
        const raw = await readFile(memoryPath, "utf8");
        const memory = parseMemoryFile(raw);
        archiveId = memory.archiveId;

        expect(memory.kind).toBe("train");
        expect(memory.id).toMatch(/^mem_/);
        expect(memory.archiveId).toBe(memory.id);
        expect(raw).not.toContain("sourceFolder");
        expect((await stat(memoryPath)).mode & 0o777).toBe(0o600);
        expect(memory.headline?.length).toBeGreaterThan(0);
        expect(memory.headline?.length).toBeLessThan(200);
        expect(memory.content.length).toBeGreaterThan(200);

        const haystack = memory.content.toLowerCase();
        const keywords = ["htmx", "hypermedia", "hx-", "swap", "ajax", "attribute"];
        const hits = keywords.filter((keyword) => haystack.includes(keyword));
        expect(hits.length).toBeGreaterThanOrEqual(2);

        if (!archiveId) throw new Error("trained store entry did not retain an archive id");
        const manifest = await readArchiveManifest(archiveId);
        expect(manifest).toMatchObject({
          memoryId: memory.id,
          slug,
          sourceFolder: corpusDir,
          headline: memory.headline,
        });
        expect(manifest?.files.length).toBeGreaterThan(0);
        for (const file of manifest?.files ?? []) {
          const privateCopy = archivedFilePath(archiveId, file.relPath);
          expect(privateCopy.startsWith(path.join(homedir(), ".duet", "train", archiveId))).toBe(
            true,
          );
          expect(privateCopy.startsWith(storeDir)).toBe(false);
          expect((await stat(privateCopy)).isFile()).toBe(true);
        }

        const listOutput = bufferStream();
        await runTrainCommand(["list", "--json"], {
          stdout: listOutput.stream,
          stderr: bufferStream().stream,
          cwd: corpusDir,
        });
        const entries = JSON.parse(listOutput.read()) as TrainListEntryJson[];
        expect(entries.find((entry) => entry.slug === slug)).toMatchObject({
          memoryId: memory.id,
          headline: memory.headline,
          sourceFolder: corpusDir,
          hasArchive: true,
          store: storeDir,
        });
      } catch (error) {
        console.error("train stdout:\n", stdout.read());
        console.error("train stderr:\n", stderr.read());
        throw error;
      } finally {
        if (archiveId) await removeArchive(archiveId);
        await rm(treeRoot, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
