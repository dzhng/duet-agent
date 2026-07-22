import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, spyOn } from "bun:test";

import { loadPinnedStorePack } from "../src/memory/store/pack.js";
import { writeEntry, type MemoryEntryInput } from "../src/memory/store/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("pinned memory-store pack", () => {
  testIfDocker("keeps newest entries and evicts the oldest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "duet-memory-store-pack-"));
    const store = join(root, ".agents", "memories");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const oldest = "a".repeat(24_000);
      const middle = "b".repeat(24_000);
      const newest = "c".repeat(24_000);
      await writeEntry(store, entry("oldest", 1, oldest));
      await writeEntry(store, entry("middle", 2, middle));
      await writeEntry(store, entry("newest", 3, newest));

      const pack = await loadPinnedStorePack({ stores: [store] });

      expect(pack.entries.map(({ slug, content }) => ({ slug, content }))).toEqual([
        { slug: "newest", content: newest },
        { slug: "middle", content: middle },
      ]);
      expect(pack.dropped).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[duet-agent] pinned memory store context exceeded 15,000-token cap; dropped 1 older memory entry.",
      );
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("truncates one oversized newest entry deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "duet-memory-store-oversized-"));
    const store = join(root, ".agents", "memories");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeEntry(store, entry("oversized", 1, "abcdefghijklmnopqrst"));

      const pack = await loadPinnedStorePack({ stores: [store], tokenBudget: 3 });

      expect(pack.entries.map(({ slug, content }) => ({ slug, content }))).toEqual([
        { slug: "oversized", content: "abcdefghi" },
      ]);
      expect(pack.dropped).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[duet-agent] pinned memory store context exceeded 3-token cap; dropped 0 older memory entries and truncated the newest entry.",
      );
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  testIfDocker("warns and skips a malformed file without losing valid entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "duet-memory-store-malformed-"));
    const store = join(root, ".agents", "memories");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeEntry(store, entry("valid", 1, "valid memory"));
      await mkdir(store, { recursive: true });
      await writeFile(join(store, "broken.md"), "not frontmatter", "utf8");

      const pack = await loadPinnedStorePack({ stores: [store] });

      expect(pack.entries.map(({ slug, content }) => ({ slug, content }))).toEqual([
        { slug: "valid", content: "valid memory" },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /^\[duet-agent\] skipped malformed memory store entry .*\/broken\.md: /,
      );
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function entry(slug: string, createdAt: number, content: string): MemoryEntryInput {
  return {
    slug,
    version: 1,
    id: `mem_${slug}`,
    kind: "train",
    createdAt,
    content,
  };
}
