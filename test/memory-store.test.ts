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

describe("memory identifier containment", () => {
  const base = {
    version: 1 as const,
    kind: "note" as const,
    createdAt: 1_700_000_000_000,
    content: "safe body\n",
  };

  test("rejects parsed ids that are not safe path segments", () => {
    const file = (id: string, archiveId?: string) =>
      [
        "---",
        `version: 1`,
        `id: ${JSON.stringify(id)}`,
        `kind: "note"`,
        `createdAt: 1700000000000`,
        ...(archiveId === undefined ? [] : [`archiveId: ${JSON.stringify(archiveId)}`]),
        "---",
        "body",
        "",
      ].join("\n");
    expect(() => parseMemoryFile(file("../escape"))).toThrow("safe path segment");
    expect(() => parseMemoryFile(file("mem_ok", "../../important"))).toThrow("safe path segment");
    expect(() => parseMemoryFile(file("mem_ok", "a/b"))).toThrow("safe path segment");
    expect(() => parseMemoryFile(file("mem_ok", ".."))).toThrow("safe path segment");
  });

  test("rejects serializing ids that are not safe path segments", () => {
    expect(() => serializeMemoryFile({ ...base, id: "../escape" })).toThrow("safe path segment");
    expect(() => serializeMemoryFile({ ...base, id: "mem_ok", archiveId: "nested/id" })).toThrow(
      "safe path segment",
    );
  });
});

describe("hand-written memory files", () => {
  // What an agent writes with a heredoc instead of `duet memory add`: plain
  // YAML scalars, keys in whatever order came to mind, no id, no createdAt.
  const handWritten = [
    "---",
    "kind: note",
    "priority: high",
    "source: imported-paige-channel",
    "tags: [reading, books]",
    "version: 1",
    "---",
    "# Paige domain facts\n",
  ].join("\n");

  test("accepts plain scalars in any key order, deriving id and createdAt from the file", () => {
    const record = parseMemoryFile(handWritten, {
      derived: { id: "mem_paige-domain-facts", createdAt: 1_787_934_002_586 },
    });

    expect(record).toEqual({
      version: 1,
      id: "mem_paige-domain-facts",
      kind: "note",
      createdAt: 1_787_934_002_586,
      priority: "high",
      source: "imported-paige-channel",
      tags: ["reading", "books"],
      content: "# Paige domain facts\n",
    });
    // Re-serializing writes the canonical form, so the next reader needs no derivation.
    expect(serializeMemoryFile(record)).toBe(
      [
        "---",
        "version: 1",
        'id: "mem_paige-domain-facts"',
        'kind: "note"',
        "createdAt: 1787934002586",
        'priority: "high"',
        'source: "imported-paige-channel"',
        'tags: ["reading", "books"]',
        "---",
        "# Paige domain facts\n",
      ].join("\n"),
    );
  });

  test("defaults version and kind, and keeps quoted and plain scalars equivalent", () => {
    const record = parseMemoryFile(
      "---\nheadline: 'Single quoted'\nnote: plain text with: colon\n---\nbody\n",
      {
        derived: { id: "mem_x", createdAt: 5 },
      },
    );
    expect(record).toMatchObject({
      version: 1,
      kind: "note",
      headline: "Single quoted",
      extra: { note: "plain text with: colon" },
    });
  });

  test("still refuses a file with no frontmatter at all, and one that names an unknown kind", () => {
    expect(() =>
      parseMemoryFile("# just markdown\n", { derived: { id: "mem_x", createdAt: 5 } }),
    ).toThrow("frontmatter delimiter");
    expect(() =>
      parseMemoryFile("---\nkind: dream\n---\nbody\n", { derived: { id: "mem_x", createdAt: 5 } }),
    ).toThrow("Invalid memory kind: dream");
  });

  test("without a derivation source, id and createdAt remain required", () => {
    expect(() => parseMemoryFile("---\nkind: note\n---\nbody\n")).toThrow("Frontmatter id");
  });
});

describe("the memory file that broke a workspace", () => {
  // Verbatim shape of a file an agent wrote by hand on a production VM: plain
  // scalars, no id, no createdAt. It must parse as-is.
  test("parses without any edits once the store supplies an identity", async () => {
    const text = await readFile(fixturePath("hand-written-by-agent.md"), "utf8");

    const record = parseMemoryFile(text, { derived: { id: "mem_derived", createdAt: 7 } });

    expect(record).toEqual({
      version: 1,
      id: "mem_derived",
      kind: "note",
      createdAt: 7,
      priority: "high",
      source: "imported-family-records",
      content:
        "# Family domain boundaries\n\n- This folder holds the family records; the agent answers only from them.\n",
    });
  });
});

describe("frontmatter edge cases", () => {
  test("round-trips an escaped quote inside an inline array", () => {
    const record = parseMemoryFile(
      serializeMemoryFile({
        version: 1,
        id: "mem_q",
        kind: "note",
        createdAt: 1,
        tags: ['a"b', "c, d"],
        content: "body\n",
      }),
    );
    expect(record.tags).toEqual(['a"b', "c, d"]);
  });

  test("a blank-valued key still counts toward the duplicate check", () => {
    expect(() =>
      parseMemoryFile("---\nkind:\nkind: train\nid: mem_x\ncreatedAt: 1\n---\nbody\n"),
    ).toThrow("Duplicate frontmatter key: kind");
  });
});
