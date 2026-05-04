import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryDiscoveryOptions } from "../types/config.js";
import type { Observation, ObservationalMemorySnapshot } from "../types/memory.js";
import type { MemoryStore } from "./store.js";

type MemoryDatabase = PGlite;

function buildMemoryDiscoveryOptions(options: MemoryDiscoveryOptions | undefined, cwd: string) {
  return {
    path: options?.path ? resolveMemoryPath(options.path, cwd) : undefined,
  };
}

export async function loadDiscoveredMemory(
  discoveryOptions: MemoryDiscoveryOptions | undefined,
  cwd: string,
  store: MemoryStore,
): Promise<() => void> {
  const options = buildMemoryDiscoveryOptions(discoveryOptions, cwd);
  if (!options.path) {
    return () => {};
  }

  const database = await openMemoryDatabase(options.path);
  const snapshot = await readMemorySnapshot(database);
  await store.replaceObservations(snapshot.observations);

  const persist = async () => {
    await writeMemorySnapshot(database, await store.getSnapshot());
  };
  await persist();
  const unsubscribe = store.on(() => {
    void persist();
  });
  return () => {
    unsubscribe();
    void database.close();
  };
}

async function openMemoryDatabase(path: string): Promise<MemoryDatabase> {
  mkdirSync(dirname(path), { recursive: true });
  const database = new PGlite(path);
  await database.exec(`
    CREATE TABLE IF NOT EXISTS observations (
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
  `);
  return database;
}

async function readMemorySnapshot(database: MemoryDatabase): Promise<ObservationalMemorySnapshot> {
  const result = await database.query<ObservationRow>(
    `SELECT id, created_at, observed_date, referenced_date, relative_date, time_of_day, priority, scope, source_json, content, tags_json
     FROM observations
     ORDER BY created_at ASC`,
  );
  const observations = result.rows.map(rowToObservation);
  return {
    observations,
    estimatedTokens: {
      observations: estimateTokens(observations.map((item) => item.content).join("\n")),
    },
    updatedAt: Date.now(),
  };
}

async function writeMemorySnapshot(
  database: MemoryDatabase,
  snapshot: ObservationalMemorySnapshot,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.exec("DELETE FROM observations");
    for (const observation of snapshot.observations) {
      await tx.query(
        `INSERT INTO observations (
          id, created_at, observed_date, referenced_date, relative_date, time_of_day,
          priority, scope, source_json, content, tags_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          created_at = EXCLUDED.created_at,
          observed_date = EXCLUDED.observed_date,
          referenced_date = EXCLUDED.referenced_date,
          relative_date = EXCLUDED.relative_date,
          time_of_day = EXCLUDED.time_of_day,
          priority = EXCLUDED.priority,
          scope = EXCLUDED.scope,
          source_json = EXCLUDED.source_json,
          content = EXCLUDED.content,
          tags_json = EXCLUDED.tags_json`,
        [
          observation.id,
          observation.createdAt,
          observation.observedDate,
          observation.referencedDate ?? null,
          observation.relativeDate ?? null,
          observation.timeOfDay ?? null,
          observation.priority,
          observation.scope,
          JSON.stringify(observation.source),
          observation.content,
          JSON.stringify(observation.tags),
        ],
      );
    }
  });
}

function resolveMemoryPath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : join(cwd, path);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ObservationRow {
  id: string;
  created_at: number;
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: Observation["priority"];
  scope: Observation["scope"];
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    observedDate: row.observed_date,
    referencedDate: row.referenced_date ?? undefined,
    relativeDate: row.relative_date ?? undefined,
    timeOfDay: row.time_of_day ?? undefined,
    priority: row.priority,
    scope: row.scope,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
