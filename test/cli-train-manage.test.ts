import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";

import { formatTrainList, runTrainCommand } from "../src/cli/train.js";
import { appendObservation, loadStoredMemory, readAllObservations } from "../src/memory/storage.js";
import { readArchiveManifest, writeArchive } from "../src/train/archive.js";
import type { TrainListEntry, TrainManifest, TrainRecord } from "../src/train/types.js";
import { testIfDocker } from "./helpers/docker-only.js";

// The `--json` wire shape converts the internal epoch-ms `createdAt` to an ISO
// 8601 string (`toTrainListEntryJson`/`toTrainRecordJson`); the in-memory type
// keeps it numeric. Parse into these shapes so the ISO assertions type-check.
type TrainListEntryJson = Omit<TrainListEntry, "createdAt"> & { createdAt: string };
type TrainRecordJson = Omit<TrainRecord, "createdAt"> & { createdAt: string };

function bufferStream(): { stream: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

function entry(overrides: Partial<TrainListEntry> = {}): TrainListEntry {
  return {
    slug: "acme",
    memoryId: "mem_acme",
    createdAt: 1_000,
    observedDate: "2026-06-11",
    headline: "Acme platform reference",
    model: "opus-4.8",
    sourceFolder: "/corpus/acme",
    fileCount: 4,
    hasArchive: true,
    ...overrides,
  };
}

/** Seed one train-tagged row into a fresh DB and return its memory id. */
async function seedTraining(
  dbPath: string,
  dir: string,
  options: { slug: string; content: string; observedDate: string },
): Promise<string> {
  const persistence = await loadStoredMemory(dbPath, dir);
  const observation = await appendObservation(persistence.session!, {
    kind: "manual",
    observedDate: options.observedDate,
    priority: "high",
    source: { kind: "system" },
    content: options.content,
    tags: ["train", `train:${options.slug}`],
  });
  await persistence.dispose();
  return observation!.id;
}

/** The stored observation content for `memoryId`, read back from `dbPath`. */
async function storedContent(
  dbPath: string,
  dir: string,
  memoryId: string,
): Promise<string | undefined> {
  const persistence = await loadStoredMemory(dbPath, dir);
  try {
    const snapshot = await readAllObservations(persistence.session!);
    return snapshot.observations.find((row) => row.id === memoryId)?.content;
  } finally {
    await persistence.dispose();
  }
}

/** The stored epoch-ms `createdAt` for `memoryId`, read back from `dbPath`. */
async function storedCreatedAt(
  dbPath: string,
  dir: string,
  memoryId: string,
): Promise<number | undefined> {
  const persistence = await loadStoredMemory(dbPath, dir);
  try {
    const snapshot = await readAllObservations(persistence.session!);
    return snapshot.observations.find((row) => row.id === memoryId)?.createdAt;
  } finally {
    await persistence.dispose();
  }
}

describe("formatTrainList", () => {
  test("renders an empty-state hint when there are no trainings", () => {
    expect(formatTrainList([])).toBe(
      "No trainings found. Run `duet train <folder>` to create one.",
    );
  });

  test("renders a header plus one line per training with its fields", () => {
    const out = formatTrainList([entry()]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("SLUG");
    expect(lines[0]).toContain("HEADLINE");
    expect(lines[0]).toContain("MEMORY ID");
    expect(lines[1]).toContain("acme");
    expect(lines[1]).toContain("Acme platform reference");
    expect(lines[1]).toContain("opus-4.8");
    expect(lines[1]).toContain("mem_acme");
    expect(lines[1]).toContain("2026-06-11");
  });

  test("marks a row whose archive manifest is missing", () => {
    const out = formatTrainList([
      entry({ hasArchive: false, headline: undefined, model: undefined, fileCount: undefined }),
    ]);
    expect(out).toContain("(archive missing)");
  });
});

describe("duet train list (end-to-end through runTrainCommand)", () => {
  testIfDocker("returns one entry per train-tagged row, slug parsed, newest first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-list-"));
    const dbPath = join(dir, "memory.db");
    try {
      const persistence = await loadStoredMemory(dbPath, dir);
      const session = persistence.session!;
      // Two trainings plus one unrelated observation that must be excluded.
      await appendObservation(session, {
        kind: "manual",
        observedDate: "2026-06-01",
        priority: "high",
        source: { kind: "system" },
        content: "older training",
        tags: ["train", "train:alpha"],
      });
      const beta = await appendObservation(session, {
        kind: "manual",
        observedDate: "2026-06-10",
        priority: "high",
        source: { kind: "system" },
        content: "newer training",
        tags: ["train", "train:beta"],
      });
      await appendObservation(session, {
        kind: "observation",
        observedDate: "2026-06-05",
        priority: "low",
        source: { kind: "system" },
        content: "not a training",
        tags: ["misc"],
      });
      await persistence.dispose();

      const stdout = bufferStream();
      await runTrainCommand(["list", "--db", dbPath, "--json"], {
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });

      const entries = JSON.parse(stdout.read()) as TrainListEntryJson[];
      expect(entries).toHaveLength(2);
      // Sorted newest-first by createdAt: beta was appended after alpha.
      expect(entries.map((e) => e.slug)).toEqual(["beta", "alpha"]);
      // `createdAt` is emitted as the ISO 8601 string of the stored epoch ms,
      // not the raw number — the exact value, matched against the DB row.
      expect(entries[0]!.createdAt).toBe(new Date(beta!.createdAt).toISOString());
      for (const e of entries) {
        expect(e.hasArchive).toBe(false);
        expect(e.headline).toBeUndefined();
        expect(e.fileCount).toBeUndefined();
        expect(e.memoryId).toMatch(/^mem_/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("joins the archive manifest fields when the archive is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-list-archive-"));
    const dbPath = join(dir, "memory.db");
    // Archives are rooted at os.homedir(), which Bun resolves at startup and
    // does not re-read from process.env.HOME — the Docker container is the
    // sandbox here (testIfDocker), not an env override.
    try {
      const memoryId = await seedTraining(dbPath, dir, {
        slug: "delta",
        content: "delta training",
        observedDate: "2026-06-08",
      });

      const sourceFile = join(dir, "overview.md");
      await writeFile(sourceFile, "# Delta\n");
      const manifest: TrainManifest = {
        memoryId,
        slug: "delta",
        createdAt: Date.now(),
        sourceFolder: dir,
        model: "opus-4.8",
        headline: "Delta platform reference",
        files: [{ relPath: "overview.md", bytes: 8, sha256: "abc" }],
      };
      await writeArchive({
        memoryId,
        files: [{ relPath: "overview.md", absPath: sourceFile, bytes: 8, sha256: "abc" }],
        manifest,
      });

      const stdout = bufferStream();
      await runTrainCommand(["list", "--db", dbPath, "--json"], {
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });

      const entries = JSON.parse(stdout.read()) as TrainListEntry[];
      expect(entries).toHaveLength(1);
      const delta = entries[0]!;
      expect(delta.slug).toBe("delta");
      expect(delta.hasArchive).toBe(true);
      expect(delta.headline).toBe("Delta platform reference");
      expect(delta.model).toBe("opus-4.8");
      expect(delta.fileCount).toBe(1);
      expect(delta.sourceFolder).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("duet train show", () => {
  testIfDocker("resolves a slug to its record plus full content as --json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-show-"));
    const dbPath = join(dir, "memory.db");
    try {
      await seedTraining(dbPath, dir, {
        slug: "gamma",
        content: "gamma synthesized memory",
        observedDate: "2026-06-09",
      });

      const stdout = bufferStream();
      await runTrainCommand(["show", "gamma", "--db", dbPath, "--json"], {
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });

      const record = JSON.parse(stdout.read()) as TrainRecordJson;
      expect(record.slug).toBe("gamma");
      expect(record.content).toBe("gamma synthesized memory");
      expect(record.memoryId).toMatch(/^mem_/);
      expect(record.hasArchive).toBe(false);
      expect(record.files).toBeUndefined();
      // `createdAt` is the ISO 8601 string of the row's stored epoch ms.
      const createdMs = await storedCreatedAt(dbPath, dir, record.memoryId);
      expect(record.createdAt).toBe(new Date(createdMs!).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker("includes the archived file paths when the archive is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-show-archive-"));
    const dbPath = join(dir, "memory.db");
    try {
      const memoryId = await seedTraining(dbPath, dir, {
        slug: "epsilon",
        content: "epsilon training",
        observedDate: "2026-06-10",
      });

      const sourceFile = join(dir, "overview.md");
      await writeFile(sourceFile, "# Epsilon\n");
      const archiveRoot = await writeArchive({
        memoryId,
        files: [{ relPath: "overview.md", absPath: sourceFile, bytes: 10, sha256: "abc" }],
        manifest: {
          memoryId,
          slug: "epsilon",
          createdAt: Date.now(),
          sourceFolder: dir,
          model: "opus-4.8",
          headline: "Epsilon reference",
          files: [{ relPath: "overview.md", bytes: 10, sha256: "abc" }],
        },
      });

      const stdout = bufferStream();
      await runTrainCommand(["show", "epsilon", "--db", dbPath, "--json"], {
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });

      const record = JSON.parse(stdout.read()) as TrainRecordJson;
      expect(record.slug).toBe("epsilon");
      expect(record.hasArchive).toBe(true);
      expect(record.fileCount).toBe(1);
      // Paths point at the archived copies (where writeArchive actually put
      // them), not the original sources.
      expect(record.files).toEqual([join(archiveRoot, "files", "overview.md")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("duet train update", () => {
  testIfDocker("replaces the stored content in place from --content-file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-update-"));
    const dbPath = join(dir, "memory.db");
    try {
      const memoryId = await seedTraining(dbPath, dir, {
        slug: "omega",
        content: "original synthesized memory",
        observedDate: "2026-06-09",
      });

      const contentFile = join(dir, "edited.md");
      await writeFile(contentFile, "hand-corrected memory text");

      const stdout = bufferStream();
      await runTrainCommand(
        ["update", "omega", "--content-file", contentFile, "--db", dbPath, "--json"],
        { stdout: stdout.stream, stderr: bufferStream().stream },
      );

      // The command echoes the updated record...
      const record = JSON.parse(stdout.read()) as TrainRecord;
      expect(record.slug).toBe("omega");
      expect(record.memoryId).toBe(memoryId);
      expect(record.content).toBe("hand-corrected memory text");

      // ...and the row on disk actually changed (same id, new content).
      expect(await storedContent(dbPath, dir, memoryId)).toBe("hand-corrected memory text");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("duet train delete", () => {
  testIfDocker("removes the row and its corpus archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duet-train-delete-"));
    const dbPath = join(dir, "memory.db");
    try {
      const memoryId = await seedTraining(dbPath, dir, {
        slug: "sigma",
        content: "sigma training",
        observedDate: "2026-06-09",
      });

      const sourceFile = join(dir, "overview.md");
      await writeFile(sourceFile, "# Sigma\n");
      const manifest: TrainManifest = {
        memoryId,
        slug: "sigma",
        createdAt: Date.now(),
        sourceFolder: dir,
        model: "opus-4.8",
        headline: "Sigma reference",
        files: [{ relPath: "overview.md", bytes: 8, sha256: "abc" }],
      };
      await writeArchive({
        memoryId,
        files: [{ relPath: "overview.md", absPath: sourceFile, bytes: 8, sha256: "abc" }],
        manifest,
      });
      // Archive is present before the delete.
      expect(await readArchiveManifest(memoryId)).not.toBeUndefined();

      const stdout = bufferStream();
      await runTrainCommand(["delete", "sigma", "--db", dbPath, "--json"], {
        stdout: stdout.stream,
        stderr: bufferStream().stream,
      });

      expect(JSON.parse(stdout.read())).toEqual({ deleted: true, slug: "sigma", memoryId });
      // Row is gone from the DB and the archive was removed with it.
      expect(await storedContent(dbPath, dir, memoryId)).toBeUndefined();
      expect(await readArchiveManifest(memoryId)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
