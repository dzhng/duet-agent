import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  parseMemoryFile,
  serializeMemoryFile,
  slugFromFilename,
} from "../src/memory/store/file.js";

const fixturePath = (name: string): string =>
  new URL(`fixtures/memory-store/${name}`, import.meta.url).pathname;

describe("memory file codec", () => {
  test("parses and byte-stably serializes the complete golden record", async () => {
    const text = await readFile(fixturePath("happy.md"), "utf8");

    const record = parseMemoryFile(text);

    expect(record).toEqual({
      version: 1,
      id: "mem_train_001",
      kind: "train",
      createdAt: 1_784_737_200_000,
      headline: "API operating model",
      model: "opus-4.8",
      fileCount: 3,
      archiveId: "archive_001",
      priority: "high",
      source: "system",
      tags: ["train", "api"],
      content: "# API operating model\n\nKeep every retry idempotent.\n",
    });
    expect(serializeMemoryFile(record)).toBe(text);
  });

  test.each([
    "missing-optional-keys.md",
    "unknown-extra-keys.md",
    "crlf.md",
    "unicode-headline.md",
    "filename-wins.md",
  ])("round-trips accepted golden bytes: %s", async (name) => {
    const text = await readFile(fixturePath(name), "utf8");
    expect(serializeMemoryFile(parseMemoryFile(text))).toBe(text);
  });

  test("accepts records with no optional frontmatter", async () => {
    const text = await readFile(fixturePath("missing-optional-keys.md"), "utf8");
    expect(parseMemoryFile(text)).toEqual({
      version: 1,
      id: "mem_note_001",
      kind: "note",
      createdAt: 1_784_737_200_001,
      content: "Only required metadata is present.\n",
    });
  });

  test("preserves unknown scalar keys", async () => {
    const text = await readFile(fixturePath("unknown-extra-keys.md"), "utf8");

    // Preserve is safer for content-only edits: an older client must not erase newer metadata.
    expect(parseMemoryFile(text).extra).toEqual({
      reviewedBy: "Ada",
      confidence: 0.75,
      channels: ["docs", "support"],
    });
  });

  test("rejects an empty golden body", async () => {
    const text = await readFile(fixturePath("empty-body.md"), "utf8");
    expect(() => parseMemoryFile(text)).toThrow("Memory content cannot be blank");
  });

  test("retains unicode headlines", async () => {
    const text = await readFile(fixturePath("unicode-headline.md"), "utf8");
    expect(parseMemoryFile(text).headline).toBe("วิธีใช้ café 🚆");
  });

  test("never accepts private sourceFolder paths as forward-compatible metadata", () => {
    expect(() =>
      parseMemoryFile(
        '---\nversion: 1\nid: "mem_private"\nkind: "train"\ncreatedAt: 1\nsourceFolder: "/vm/private"\n---\nBody.\n',
      ),
    ).toThrow("sourceFolder is private archive metadata");
  });

  test("derives slugs only from safe bare markdown filenames", () => {
    expect(slugFromFilename("project-guide.md")).toBe("project-guide");
    expect(() => slugFromFilename("../project-guide.md")).toThrow("bare .md filename");
    expect(() => slugFromFilename("project-guide.txt")).toThrow("bare .md filename");
    expect(() => slugFromFilename("Upper_Case.md")).toThrow("Unsafe memory slug");
  });
});
