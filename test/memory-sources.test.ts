import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect } from "bun:test";

import { mergeListings, resolveSources } from "../src/memory/store/sources.js";
import { DEFAULT_MEMORY_DB_PATH } from "../src/session/session-manager.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("memory source resolution", () => {
  testIfDocker(
    "discovers inherited stores nearest-first and chooses the nearest agent for writes",
    async () => {
      const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-sources-"));
      const child = join(root, "child");
      const work = join(child, "work");
      const childStore = join(child, ".agents", "memories");
      const rootStore = join(root, ".agents", "memories");
      try {
        await fileSystem.mkdir(work, { recursive: true });
        await fileSystem.mkdir(childStore, { recursive: true });
        await fileSystem.mkdir(rootStore, { recursive: true });

        expect(await resolveSources({ stores: [], dbs: [] }, work)).toEqual({
          stores: [childStore, rootStore],
          dbs: [DEFAULT_MEMORY_DB_PATH],
          writeTarget: { kind: "store", path: childStore },
        });
      } finally {
        await fileSystem.rm(root, { recursive: true, force: true });
      }
    },
  );

  testIfDocker(
    "explicit repeatable flags replace discovery and preserve family order",
    async () => {
      const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-explicit-sources-"));
      const cwd = join(root, "work");
      const discovered = join(root, ".agents", "memories");
      const storeA = join(root, "explicit-a");
      const storeB = join(root, "explicit-b");
      const dbA = join(root, "a.db");
      const dbB = join(root, "b.db");
      try {
        await fileSystem.mkdir(cwd, { recursive: true });
        await fileSystem.mkdir(discovered, { recursive: true });

        expect(await resolveSources({ stores: [storeA, storeB], dbs: [dbA, dbB] }, cwd)).toEqual({
          stores: [storeA, storeB],
          dbs: [dbA, dbB],
        });
      } finally {
        await fileSystem.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("memory listing merge", () => {
  testIfDocker(
    "resolves slug collisions by source precedence before sorting winners newest-first",
    () => {
      const childStore = "/project/child/.agents/memories";
      const rootStore = "/project/.agents/memories";
      const rows = mergeListings(
        [
          {
            source: childStore,
            entries: [
              { slug: "shared", createdAt: 10, content: "child" },
              { slug: "older", createdAt: 20, content: "older" },
            ],
          },
          {
            source: rootStore,
            entries: [
              { slug: "shared", createdAt: 50, content: "root" },
              { slug: "newest", createdAt: 40, content: "newest" },
            ],
          },
        ],
        [
          {
            source: "/project/memory.db",
            entries: [{ slug: "shared", createdAt: 100, content: "db" }],
          },
        ],
      );

      expect(rows).toEqual([
        { slug: "newest", createdAt: 40, content: "newest", store: rootStore },
        { slug: "older", createdAt: 20, content: "older", store: childStore },
        { slug: "shared", createdAt: 10, content: "child", store: childStore },
      ]);
    },
  );
});
