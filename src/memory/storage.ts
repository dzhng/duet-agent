import type { PGlite } from "@electric-sql/pglite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  MemoryStoreEvent,
  Observation,
  ObservationalMemorySettings,
  ObservationalMemorySnapshot,
} from "../types/memory.js";
import { rebuildMemoryContextPack } from "./context-pack.js";
import { DEFAULT_EMBEDDING_MODEL, type EmbedFn } from "./embedding.js";
import { EmbeddingBackfillWorker } from "./embedding-worker.js";
import { runMigrations } from "./migrations.js";
import { openPGlite } from "./pglite.js";
import { OBSERVATIONS_SCHEMA_SQL } from "./schema.js";
import type { MemoryStore } from "./store.js";

type MemoryDatabase = PGlite;
export interface MemoryPersistenceHandle {
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
  /**
   * The opened PGlite handle, exposed so tools (recall_memory, future
   * loaders) can run their own queries against the same database the
   * MemoryStore writes through. Undefined when memory persistence is
   * disabled (the no-op handle); callers must not close it.
   */
  db?: PGlite;
  /** Embedding callable shared with the backfill worker, when configured. */
  embed?: EmbedFn;
}

export interface LoadStoredMemoryOptions {
  /**
   * Embedding callable used by the background backfill worker. Omit to
   * skip embedding work entirely — useful in tests that do not exercise
   * `recall_memory`. The worker is built only when this is provided.
   */
  embed?: EmbedFn;
  /** Embedding model identifier written alongside each vector. */
  embeddingModel?: string;
  /** Optional override for the backfill log path; defaults to ~/.duet/logs/memory-backfill.log. */
  embeddingLogPath?: string;
  /**
   * Settings + sessionId used to build the initial context pack. When
   * provided, `loadStoredMemory` builds and freezes the rendered
   * memory pack as part of the load so the first turn already sees a
   * stable prefix. Omit to skip the initial build (the runner can
   * trigger it later).
   */
  contextPack?: {
    settings: ObservationalMemorySettings;
    sessionId?: string;
  };
}

export async function loadStoredMemory(
  memoryPath: string | false | undefined,
  cwd: string,
  store: MemoryStore,
  options: LoadStoredMemoryOptions = {},
): Promise<MemoryPersistenceHandle> {
  if (!memoryPath) {
    const noop = async () => {};
    return { flush: noop, dispose: noop };
  }

  const database = await openMemoryDatabase(resolveMemoryPath(memoryPath, cwd));
  const snapshot = await readMemorySnapshot(database);
  await store.replaceObservations(snapshot.observations);

  let writeQueue = Promise.resolve();
  const enqueueWrite = (event: MemoryStoreEvent) => {
    writeQueue = writeQueue.then(() => persistMemoryEvent(database, event));
    void writeQueue;
  };
  const unsubscribe = store.on(enqueueWrite);

  // The backfill worker runs whenever the CLI is up. Observers and
  // reflectors write rows during turns; embeddings catch up in the
  // background within a few batches, never blocking the foreground.
  // Skipping the worker (no `embed` option) is intentional for tests
  // and one-shot tools that do not call recall_memory.
  const worker = options.embed
    ? new EmbeddingBackfillWorker({
        db: database,
        embed: options.embed,
        model: options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        logPath: options.embeddingLogPath ?? defaultEmbeddingLogPath(),
      })
    : undefined;
  worker?.start();

  if (options.contextPack) {
    // Initial compaction trigger: freeze the rendered memory pack
    // before the first turn dispatches so the prefix is stable from
    // turn 1, not turn 2. Failure here is non-fatal: the pack stays
    // empty and the runner can trigger a refresh later.
    try {
      await rebuildMemoryContextPack({
        db: database,
        store,
        settings: options.contextPack.settings,
        ...(options.contextPack.sessionId !== undefined
          ? { sessionId: options.contextPack.sessionId }
          : {}),
      });
    } catch {
      // Pack build failed; rendered memory will be empty until the
      // next compaction trigger refreshes it. Logged silently here
      // since callers do not need the noise mid-startup.
    }
  }

  const flush = async () => {
    await writeQueue;
  };
  const dispose = async () => {
    unsubscribe();
    await worker?.stop();
    await flush();
    await database.close();
  };
  return { flush, dispose, db: database, embed: options.embed };
}

function defaultEmbeddingLogPath(): string {
  return join(homedir(), ".duet", "logs", "memory-backfill.log");
}

async function openMemoryDatabase(path: string): Promise<MemoryDatabase> {
  // Migrations run inside the same try block that triggers quarantine on
  // unreadable directories. If a migration fails on a corrupted brain,
  // the directory is moved aside and we start fresh rather than wedging
  // the agent behind an opaque PGlite abort.
  return openPGlite(path, {
    schemaSql: OBSERVATIONS_SCHEMA_SQL,
    init: async (db) => {
      await runMigrations(db);
    },
  });
}

async function readMemorySnapshot(database: MemoryDatabase): Promise<ObservationalMemorySnapshot> {
  const result = await database.query<ObservationRow>(
    `SELECT id, created_at, session_id, kind, observed_date, referenced_date, relative_date, time_of_day, priority, source_json, content, tags_json
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

async function persistMemoryEvent(
  database: MemoryDatabase,
  event: MemoryStoreEvent,
): Promise<void> {
  if (event.type === "observation_appended") {
    await upsertObservation(database, event.observation);
    return;
  }

  await syncObservations(database, event.observations);
}

async function syncObservations(
  database: MemoryDatabase,
  observations: readonly Observation[],
): Promise<void> {
  const ids = observations.map((observation) => observation.id);
  await database.transaction(async (tx) => {
    if (ids.length === 0) {
      await tx.exec("DELETE FROM observations");
    } else {
      await tx.query("DELETE FROM observations WHERE NOT (id = ANY($1::text[]))", [ids]);
    }

    for (const observation of observations) {
      await upsertObservation(tx, observation);
    }
  });
}

async function upsertObservation(
  database: Pick<MemoryDatabase, "query">,
  observation: Observation,
): Promise<void> {
  await database.query(
    `INSERT INTO observations (
      id, created_at, session_id, kind, observed_date, referenced_date, relative_date, time_of_day,
      priority, source_json, content, tags_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO UPDATE SET
      created_at = EXCLUDED.created_at,
      session_id = EXCLUDED.session_id,
      kind = EXCLUDED.kind,
      observed_date = EXCLUDED.observed_date,
      referenced_date = EXCLUDED.referenced_date,
      relative_date = EXCLUDED.relative_date,
      time_of_day = EXCLUDED.time_of_day,
      priority = EXCLUDED.priority,
      source_json = EXCLUDED.source_json,
      content = EXCLUDED.content,
      tags_json = EXCLUDED.tags_json`,
    [
      observation.id,
      observation.createdAt,
      observation.sessionId ?? null,
      observation.kind,
      observation.observedDate,
      observation.referencedDate ?? null,
      observation.relativeDate ?? null,
      observation.timeOfDay ?? null,
      observation.priority,
      JSON.stringify(observation.source),
      observation.content,
      JSON.stringify(observation.tags),
    ],
  );
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
  session_id: string | null;
  kind: Observation["kind"];
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: Observation["priority"];
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
