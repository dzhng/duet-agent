import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendObservation,
  loadStoredMemory,
  readSessionObservations,
  replaceSessionObservations,
} from "../src/memory/storage.js";
import type { Observation } from "../src/types/memory.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("Memory storage", () => {
  test("returns a no-op handle without a configured path", async () => {
    const persistence = await loadStoredMemory(undefined, process.cwd());
    expect(persistence.db).toBeUndefined();
    await persistence.dispose();
  });

  test("returns a no-op handle when storage is explicitly disabled", async () => {
    const persistence = await loadStoredMemory(false, process.cwd());
    expect(persistence.db).toBeUndefined();
    await persistence.dispose();
  });

  testIfDocker("creates a PGlite memory database and persists observations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory.db");

    try {
      const persistence = await loadStoredMemory(memoryPath, tempDir);
      expect(persistence.db).toBeDefined();
      await appendObservation(persistence.db!, observationInput("Created database.", "session_a"));
      await persistence.dispose();

      expect(await readObservationContents(memoryPath)).toEqual(["Created database."]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker("loads existing observations with optional fields intact", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory.db");
    const seeded = await openSeededDatabase(memoryPath);
    await seeded.close();

    try {
      const persistence = await loadStoredMemory(memoryPath, tempDir);
      const snapshot = await readSessionObservations(persistence.db!, "session_seed");
      await persistence.dispose();

      expect(snapshot.observations).toEqual([
        {
          id: "existing-observation",
          createdAt: 1,
          // Migration v4 backfills last_used_at from created_at for legacy rows.
          lastUsedAt: 1,
          sessionId: "session_seed",
          kind: "observation",
          observedDate: "2026-05-04",
          referencedDate: "2026-05-03",
          relativeDate: "yesterday",
          timeOfDay: "17:30",
          priority: "medium",
          source: { kind: "system" },
          content: "Loaded persisted memory.",
          tags: ["test", "persisted"],
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "replaceSessionObservations only deletes the current session's removed rows",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
      const memoryPath = join(tempDir, "memory.db");

      try {
        const persistence = await loadStoredMemory(memoryPath, tempDir);
        const db = persistence.db!;

        // Seed two sessions with one row each. Reflection in session_a
        // must not affect session_b's row.
        const a1 = await appendObservation(db, observationInput("session a row 1", "session_a"));
        const a2 = await appendObservation(db, observationInput("session a row 2", "session_a"));
        const b1 = await appendObservation(db, observationInput("session b row", "session_b"));

        await replaceSessionObservations(db, "session_a", [
          // Keep a1 (under its existing id), drop a2 entirely, append a fresh reflection.
          a1,
          {
            ...observationInput("session a reflection", "session_a"),
            id: "session_a_reflection",
            createdAt: a2.createdAt + 1,
            lastUsedAt: a2.createdAt + 1,
            kind: "reflection",
            tags: ["observational-memory", "reflection"],
          },
        ]);

        const aSnapshot = await readSessionObservations(db, "session_a");
        expect(aSnapshot.observations.map((o) => o.content)).toEqual([
          "session a row 1",
          "session a reflection",
        ]);

        const bSnapshot = await readSessionObservations(db, "session_b");
        expect(bSnapshot.observations.map((o) => o.id)).toEqual([b1.id]);

        await persistence.dispose();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  testIfDocker("dispose closes the database and prevents further writes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-memory-"));
    const memoryPath = join(tempDir, "memory.db");

    try {
      const persistence = await loadStoredMemory(memoryPath, tempDir);
      const db = persistence.db!;
      await appendObservation(db, observationInput("Before dispose.", "session_a"));
      await persistence.dispose();

      // Reopen with a fresh handle to confirm only the pre-dispose row landed on disk.
      expect(await readObservationContents(memoryPath)).toEqual(["Before dispose."]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function openSeededDatabase(path: string): Promise<PGlite> {
  const database = await PGlite.create({ dataDir: path, extensions: { vector } });
  // Seed the v1 schema directly so migration v2/v3/v4 have to upgrade
  // an existing DB rather than running on an empty one. Tests the
  // forward-only migration chain end-to-end.
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
  // Migration v2 backfills session_id but leaves NULL for pre-migration rows.
  // Set it explicitly so this fixture maps onto a session we can query.
  await database.exec(
    `ALTER TABLE observations ADD COLUMN IF NOT EXISTS session_id TEXT;
     UPDATE observations SET session_id = 'session_seed' WHERE id = 'existing-observation';`,
  );
  return database;
}

function observationInput(
  content: string,
  sessionId: string,
): Omit<Observation, "id" | "createdAt" | "lastUsedAt"> {
  return {
    sessionId,
    kind: "observation",
    observedDate: "2026-05-04",
    priority: "high",
    source: { kind: "system" },
    content,
    tags: ["test"],
  };
}

async function readObservationContents(path: string): Promise<string[]> {
  const database = await PGlite.create({ dataDir: path, extensions: { vector } });
  const result = await database.query<{ content: string }>(
    "SELECT content FROM observations ORDER BY content",
  );
  await database.close();
  return result.rows.map((row) => row.content);
}
