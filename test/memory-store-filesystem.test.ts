import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn } from "bun:test";

import {
  MAX_TRAIN_RECORD_CONTENT_BYTES,
  parseMemoryFile,
  serializeMemoryFile,
  type MemoryFileRecord,
} from "../src/memory/store/file.js";
import {
  deleteEntry,
  listStore,
  readEntry,
  updateEntry,
  writeEntry,
  type MemoryEntryInput,
} from "../src/memory/store/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

const fixtures = new URL("fixtures/memory-store/", import.meta.url).pathname;

describe("markdown memory store", () => {
  testIfDocker("lists markdown records only and takes the slug from each filename", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-"));
    const storeDir = join(root, "memories");
    try {
      await fileSystem.mkdir(storeDir);
      await fileSystem.copyFile(
        join(fixtures, "filename-wins.md"),
        join(storeDir, "filename-wins.md"),
      );
      await fileSystem.copyFile(join(fixtures, "ignored.txt"), join(storeDir, "ignored.txt"));

      const entries = await listStore(storeDir);
      const filenameRecord = await readEntry(storeDir, "filename-wins");

      expect(entries.map((entry) => entry.slug)).not.toContain("ignored");
      expect(filenameRecord.slug).toBe("filename-wins");
      expect(filenameRecord.content).toBe("The filename owns the public slug.\n");
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("creates, reads, updates, lists, and deletes exact stored values", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-crud-"));
    const storeDir = join(root, "memories");
    const input = memoryInput();
    try {
      const written = await writeEntry(storeDir, input);
      expect(written).toEqual(storedView(storeDir, input));
      expect(await readEntry(storeDir, input.slug)).toEqual(written);
      expect(await listStore(storeDir)).toEqual([written]);

      const updated = await updateEntry(storeDir, input.slug, "Updated curated body.\n");
      expect(updated.content).toBe("Updated curated body.\n");
      const updatedFile = parseMemoryFile(
        await fileSystem.readFile(join(storeDir, `${input.slug}.md`), "utf8"),
      );
      expect(updatedFile).toEqual(memoryRecord({ content: "Updated curated body.\n" }));

      expect(await deleteEntry(storeDir, input.slug)).toEqual(updated);
      expect(await listStore(storeDir)).toEqual([]);
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("keeps CRLF frontmatter when updating only the curated body", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-crlf-"));
    const storeDir = join(root, "memories");
    try {
      await fileSystem.mkdir(storeDir);
      await fileSystem.copyFile(join(fixtures, "crlf.md"), join(storeDir, "crlf.md"));

      await updateEntry(storeDir, "crlf", "Replacement body.\r\n");

      const bytes = await fileSystem.readFile(join(storeDir, "crlf.md"), "utf8");
      expect(bytes).toContain("---\r\nversion: 1\r\n");
      expect(bytes.endsWith("---\r\nReplacement body.\r\n")).toBe(true);
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("rejects traversal and unsafe slugs", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-slug-"));
    try {
      await expect(readEntry(root, "../outside")).rejects.toThrow("Unsafe memory slug");
      await expect(writeEntry(root, memoryInput({ slug: "Upper_Case" }))).rejects.toThrow(
        "Unsafe memory slug",
      );
      await expect(deleteEntry(root, "nested/name")).rejects.toThrow("Unsafe memory slug");
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("rejects symlinked stores and markdown files", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-link-"));
    const realStore = join(root, "real");
    const linkedStore = join(root, "linked");
    try {
      await fileSystem.mkdir(realStore);
      await fileSystem.symlink(realStore, linkedStore);
      await expect(listStore(linkedStore)).rejects.toThrow("Memory stores cannot be symlinks");

      const external = join(root, "external.md");
      await fileSystem.writeFile(external, serializeMemoryFile(memoryInput()));
      await fileSystem.symlink(external, join(realStore, "linked.md"));
      await expect(readEntry(realStore, "linked")).rejects.toThrow(
        "Memory files cannot be symlinks",
      );
      await expect(writeEntry(realStore, memoryInput({ slug: "linked" }))).rejects.toThrow(
        "Memory files cannot be symlinks",
      );
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("rejects blank and over-limit UTF-8 content before writing", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-content-"));
    try {
      await expect(writeEntry(root, memoryInput({ content: " \n\t" }))).rejects.toThrow(
        "Memory content cannot be blank",
      );
      await expect(
        writeEntry(
          root,
          memoryInput({ content: "é".repeat(MAX_TRAIN_RECORD_CONTENT_BYTES / 2 + 1) }),
        ),
      ).rejects.toThrow(`exceeds ${MAX_TRAIN_RECORD_CONTENT_BYTES} UTF-8 bytes`);
      await expect(listStore(root)).resolves.toEqual([]);
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("a rename failure leaves a complete old or new file, never torn bytes", async () => {
    const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-atomic-"));
    const input = memoryInput();
    const path = join(root, `${input.slug}.md`);
    try {
      await writeEntry(root, input);
      const oldBytes = await fileSystem.readFile(path, "utf8");
      const replacement = memoryInput({ content: "Entire replacement body.\n" });
      const newBytes = serializeMemoryFile(replacement);
      const rename = spyOn(fileSystem, "rename").mockRejectedValueOnce(
        new Error("injected rename failure"),
      );
      try {
        await expect(writeEntry(root, replacement)).rejects.toThrow("injected rename failure");
      } finally {
        rename.mockRestore();
      }

      const survivingBytes = await fileSystem.readFile(path, "utf8");
      expect([oldBytes, newBytes]).toContain(survivingBytes);
      expect(() => parseMemoryFile(survivingBytes)).not.toThrow();
      expect((await fileSystem.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await fileSystem.rm(root, { recursive: true, force: true });
    }
  });
});

function memoryInput(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  const { slug = "project-guide", ...recordOverrides } = overrides;
  return { slug, ...memoryRecord(recordOverrides) };
}

function memoryRecord(overrides: Partial<MemoryFileRecord> = {}): MemoryFileRecord {
  return {
    version: 1,
    id: "mem_project_guide",
    kind: "train",
    createdAt: 1_784_737_200_100,
    headline: "Project guide",
    model: "opus-4.8",
    fileCount: 2,
    archiveId: "archive_project_guide",
    priority: "high",
    source: "system",
    tags: ["train", "guide"],
    extra: { reviewedBy: "Ada" },
    content: "Original curated body.\n",
    ...overrides,
  };
}

function storedView(storeDir: string, input: MemoryEntryInput) {
  return {
    slug: input.slug,
    storeDir,
    id: input.id,
    kind: input.kind,
    createdAt: input.createdAt,
    headline: input.headline,
    model: input.model,
    fileCount: input.fileCount,
    archiveId: input.archiveId,
    content: input.content,
  };
}
