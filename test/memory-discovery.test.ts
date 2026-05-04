import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiscoveredMemory } from "../src/memory/discovery.js";
import { MemoryStore } from "../src/memory/store.js";
import type { Observation } from "../src/types/memory.js";

describe("Memory discovery", () => {
  test("is a no-op without a configured path", async () => {
    const store = new MemoryStore();
    const dispose = await loadDiscoveredMemory(undefined, process.cwd(), store);

    await store.appendObservation(createObservation("Not persisted."));
    dispose();

    const snapshot = await store.getSnapshot();
    expect(snapshot.observations).toHaveLength(1);
  });

  test("creates a PGlite memory database and persists observations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory-pglite");
    const store = new MemoryStore();

    try {
      const dispose = await loadDiscoveredMemory({ path: memoryPath }, tempDir, store);
      await store.appendObservation(createObservation("Created database."));
      await waitForObservationContents(memoryPath, ["Created database."]);
      dispose();

      const observations = await readObservationContents(memoryPath);
      expect(observations).toEqual(["Created database."]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("loads existing observations with optional fields intact", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory-pglite");
    const seeded = await openSeededDatabase(memoryPath);
    await seeded.close();
    const store = new MemoryStore();

    try {
      const dispose = await loadDiscoveredMemory({ path: memoryPath }, tempDir, store);
      const snapshot = await store.getSnapshot();
      dispose();

      expect(snapshot.observations).toEqual([
        {
          id: "existing-observation",
          createdAt: 1,
          observedDate: "2026-05-04",
          referencedDate: "2026-05-03",
          relativeDate: "yesterday",
          timeOfDay: "17:30",
          priority: "medium",
          scope: "session",
          source: { kind: "system" },
          content: "Loaded persisted memory.",
          tags: ["test", "persisted"],
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("replaceObservations persists deletions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory-pglite");
    const seeded = await openSeededDatabase(memoryPath);
    await seeded.close();
    const store = new MemoryStore();

    try {
      const dispose = await loadDiscoveredMemory({ path: memoryPath }, tempDir, store);
      await store.replaceObservations([
        createPersistedObservation("replacement", "Replacement memory."),
      ]);
      await waitForObservationContents(memoryPath, ["Replacement memory."]);
      dispose();

      expect(await readObservationContents(memoryPath)).toEqual(["Replacement memory."]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("dispose stops future persistence writes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory-pglite");
    const store = new MemoryStore();

    try {
      const dispose = await loadDiscoveredMemory({ path: memoryPath }, tempDir, store);
      await store.appendObservation(createObservation("Before dispose."));
      await waitForObservationContents(memoryPath, ["Before dispose."]);
      dispose();

      await store.appendObservation(createObservation("After dispose."));
      expect(await readObservationContents(memoryPath)).toEqual(["Before dispose."]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function openSeededDatabase(path: string): Promise<PGlite> {
  const database = new PGlite(path);
  await database.exec(`
    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL,
      observed_date TEXT NOT NULL,
      referenced_date TEXT,
      relative_date TEXT,
      time_of_day TEXT,
      priority TEXT NOT NULL,
      scope TEXT NOT NULL,
      source_json TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL
    );
    INSERT INTO observations (
      id, created_at, observed_date, referenced_date, relative_date, time_of_day,
      priority, scope, source_json, content, tags_json
    ) VALUES (
      'existing-observation',
      1,
      '2026-05-04',
      '2026-05-03',
      'yesterday',
      '17:30',
      'medium',
      'session',
      '{"kind":"system"}',
      'Loaded persisted memory.',
      '["test","persisted"]'
    );
  `);
  return database;
}

function createObservation(content: string): Omit<Observation, "id" | "createdAt"> {
  return {
    observedDate: "2026-05-04",
    priority: "high",
    scope: "session",
    source: { kind: "system" },
    content,
    tags: ["test"],
  };
}

function createPersistedObservation(id: string, content: string): Observation {
  return {
    id,
    createdAt: 2,
    ...createObservation(content),
  };
}

async function readObservationContents(path: string): Promise<string[]> {
  const database = new PGlite(path);
  const result = await database.query<{ content: string }>(
    "SELECT content FROM observations ORDER BY id",
  );
  await database.close();
  return result.rows.map((row) => row.content);
}

async function waitForObservationContents(path: string, expected: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (JSON.stringify(await readObservationContents(path)) === JSON.stringify(expected)) {
      return;
    }
    await Bun.sleep(10);
  }
  expect(await readObservationContents(path)).toEqual(expected);
}
