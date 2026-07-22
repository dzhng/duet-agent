import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect } from "bun:test";

import { runTrainCommand } from "../src/cli/train.js";
import { readEntry, writeEntry } from "../src/memory/store/store.js";
import { appendObservation, loadStoredMemory, readAllObservations } from "../src/memory/storage.js";
import { archivedFilePath, readArchiveManifest, removeArchive } from "../src/train/archive.js";
import type { TrainListEntry, TrainRecord } from "../src/train/types.js";
import { testIfDocker } from "./helpers/docker-only.js";

type TrainListEntryJson = Omit<TrainListEntry, "createdAt"> & { createdAt: string };
type TrainRecordJson = Omit<TrainRecord, "createdAt"> & { createdAt: string };

describe("duet train file-store management", () => {
  testIfDocker("normalizes store slugs before synthesis and persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-store-slug-"));
    const corpus = join(dir, "corpus");
    const store = join(dir, ".agents", "memories");
    let memoryId: string | undefined;
    try {
      await mkdir(corpus, { recursive: true });
      await writeFile(join(corpus, "facts.md"), "# Facts\n");
      await runTrainCommand([corpus, "--slug", "Foo--Bar", "--store", store], {
        stdout: bufferStream().stream,
        stderr: bufferStream().stream,
        synthesize: async ({ slug }) => {
          expect(slug).toBe("foo-bar");
          return { headline: "Normalized", observationContent: "Normalized slug content." };
        },
      });

      const stored = await readEntry(store, "foo-bar");
      memoryId = stored.id;
      expect(stored.content).toBe("Normalized slug content.");
    } finally {
      if (memoryId) await removeArchive(memoryId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "persists synthesis as a private store file while keeping source paths in the archive",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-train-store-create-"));
      const corpus = join(dir, "corpus");
      const store = join(dir, ".agents", "memories");
      let memoryId: string | undefined;
      try {
        await mkdir(corpus, { recursive: true });
        await writeFile(join(corpus, "facts.md"), "# Facts\nStore-backed training.\n");
        await runTrainCommand(
          [
            corpus,
            "--slug",
            "project-facts",
            "--store",
            store,
            "--model",
            "duet-gateway:sonnet-4.6",
          ],
          {
            stdout: bufferStream().stream,
            stderr: bufferStream().stream,
            synthesize: async () => ({
              headline: "Project facts",
              observationContent: "The project uses store-backed training.",
            }),
          },
        );

        const stored = await readEntry(store, "project-facts");
        memoryId = stored.id;
        const archiveId = stored.archiveId;
        if (!archiveId) throw new Error("store-backed training did not retain its archive id");
        expect(stored).toMatchObject({
          id: expect.stringMatching(/^mem_/),
          kind: "train",
          headline: "Project facts",
          model: "duet-gateway:sonnet-4.6",
          fileCount: 1,
          archiveId: stored.id,
          content: "The project uses store-backed training.",
        });
        const recordPath = join(store, "project-facts.md");
        const raw = await readFile(recordPath, "utf8");
        expect(raw).not.toContain("sourceFolder");
        expect((await stat(recordPath)).mode & 0o777).toBe(0o600);

        const manifest = await readArchiveManifest(archiveId);
        expect(manifest).toMatchObject({
          memoryId: stored.id,
          slug: "project-facts",
          sourceFolder: corpus,
          headline: "Project facts",
        });
        expect(await readFile(archivedFilePath(archiveId, "facts.md"), "utf8")).toBe(
          "# Facts\nStore-backed training.\n",
        );
      } finally {
        if (memoryId) await removeArchive(memoryId);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  testIfDocker(
    "unions repeatable sources and mutates the first store containing a slug",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-train-store-manage-"));
      const childStore = join(dir, "child", ".agents", "memories");
      const rootStore = join(dir, ".agents", "memories");
      const dbPath = join(dir, "memory.db");
      const secondDbPath = join(dir, "second-memory.db");
      const now = Date.now();
      try {
        await writeEntry(childStore, trainEntry("shared", "mem_child", 1, "child copy"));
        await writeEntry(
          childStore,
          trainEntry("child-only", "mem_child_only", now - 100_000, "child only"),
        );
        await writeEntry(rootStore, trainEntry("shared", "mem_root", now + 200_000, "root copy"));
        await writeEntry(
          rootStore,
          trainEntry("root-newest", "mem_root_newest", now + 300_000, "root newest"),
        );
        const dbSharedId = await seedTraining(dbPath, dir, "shared", "database copy");
        await seedTraining(dbPath, dir, "db-only", "database only");
        await seedTraining(secondDbPath, dir, "second-db-only", "second database only");

        const sourceArgs = [
          "--store",
          childStore,
          "--store",
          rootStore,
          "--db",
          dbPath,
          "--db",
          secondDbPath,
        ];
        const listOutput = bufferStream();
        await runTrainCommand(["list", ...sourceArgs, "--json"], {
          stdout: listOutput.stream,
          stderr: bufferStream().stream,
        });
        const listed = JSON.parse(listOutput.read()) as TrainListEntryJson[];
        expect(listed.map((entry) => entry.slug)).toEqual(
          expect.arrayContaining([
            "root-newest",
            "db-only",
            "second-db-only",
            "child-only",
            "shared",
          ]),
        );
        expect(listed[0]?.slug).toBe("root-newest");
        expect(listed.at(-1)?.slug).toBe("shared");
        expect(listed.filter((entry) => entry.slug === "shared")).toHaveLength(1);
        expect(listed.find((entry) => entry.slug === "shared")).toMatchObject({
          memoryId: "mem_child",
          store: childStore,
        });
        expect(listed.find((entry) => entry.slug === "db-only")?.store).toBeUndefined();

        const shown = await show("shared", sourceArgs);
        expect(shown.content).toBe("child copy");
        expect(shown.store).toBe(childStore);

        const contentFile = join(dir, "updated.md");
        await writeFile(contentFile, "updated child copy");
        await runTrainCommand(
          ["update", "shared", "--content-file", contentFile, ...sourceArgs, "--json"],
          { stdout: bufferStream().stream, stderr: bufferStream().stream },
        );
        expect((await readEntry(childStore, "shared")).content).toBe("updated child copy");
        expect((await readEntry(rootStore, "shared")).content).toBe("root copy");
        expect(await dbContent(dbPath, dir, dbSharedId)).toBe("database copy");

        await runTrainCommand(["delete", "shared", ...sourceArgs], {
          stdout: bufferStream().stream,
          stderr: bufferStream().stream,
        });
        expect((await show("shared", sourceArgs)).content).toBe("root copy");

        await runTrainCommand(["delete", "shared", ...sourceArgs], {
          stdout: bufferStream().stream,
          stderr: bufferStream().stream,
        });
        const revealedDb = await show("shared", sourceArgs);
        expect(revealedDb.content).toBe("database copy");
        expect(revealedDb.store).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

function trainEntry(slug: string, id: string, createdAt: number, content: string) {
  return { slug, version: 1 as const, id, kind: "train" as const, createdAt, content };
}

async function seedTraining(
  dbPath: string,
  cwd: string,
  slug: string,
  content: string,
): Promise<string> {
  const persistence = await loadStoredMemory(dbPath, cwd);
  try {
    const session = persistence.session;
    if (!session) throw new Error("test DB persistence was unexpectedly disabled");
    const observation = await appendObservation(session, {
      kind: "manual",
      observedDate: "2026-07-23",
      priority: "high",
      source: { kind: "system" },
      content,
      tags: ["train", `train:${slug}`],
    });
    if (!observation) throw new Error("test training row was not persisted");
    return observation.id;
  } finally {
    await persistence.dispose();
  }
}

async function dbContent(dbPath: string, cwd: string, memoryId: string) {
  const persistence = await loadStoredMemory(dbPath, cwd);
  try {
    const session = persistence.session;
    if (!session) throw new Error("test DB persistence was unexpectedly disabled");
    const snapshot = await readAllObservations(session);
    return snapshot.observations.find((entry) => entry.id === memoryId)?.content;
  } finally {
    await persistence.dispose();
  }
}

async function show(slug: string, sourceArgs: string[]): Promise<TrainRecordJson> {
  const output = bufferStream();
  await runTrainCommand(["show", slug, ...sourceArgs, "--json"], {
    stdout: output.stream,
    stderr: bufferStream().stream,
  });
  return JSON.parse(output.read()) as TrainRecordJson;
}

function bufferStream(): { stream: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}
