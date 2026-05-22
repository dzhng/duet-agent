import { homedir } from "node:os";
import { join } from "node:path";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Observation, ObservationalMemorySettings } from "../types/memory.js";
import type { EmbedFn } from "./embedding.js";
import { EmbeddingBackfillWorker } from "./embedding-worker.js";
import { rebuildMemoryContextPack } from "./context-pack.js";
import { runMigrations } from "./migrations.js";
import { estimateTokens } from "./observational.js";
import { MemorySession } from "./session.js";
import type { MemoryContextCache } from "./store.js";
import { nanoid } from "nanoid";

/**
 * Handle returned by `loadStoredMemory`. Callers pass `session` into the
 * storage helpers, which each open the underlying PGlite handle just long
 * enough to run their queries and then hand it back to the idle-close
 * timer so a peer duet CLI can acquire the cross-process lock between
 * bursts. `session` is undefined when memory persistence is disabled.
 */
export interface MemoryPersistenceHandle {
  session: MemorySession | undefined;
  embed: EmbedFn | undefined;
  dispose: () => Promise<void>;
}

export interface LoadStoredMemoryOptions {
  embed?: EmbedFn;
  embeddingLogPath?: string;
  /** When set, freeze the initial context pack into the cache before the first turn dispatches. */
  contextPack?: {
    cache: MemoryContextCache;
    settings: ObservationalMemorySettings;
    sessionId?: string;
  };
  /**
   * Invoked when the memory database at the configured path could not be
   * opened and was renamed aside to start fresh. `backupPath` is the
   * `<path>.corrupted-<iso-timestamp>` directory the prior contents now
   * live under; `cause` is the underlying error that triggered
   * quarantine. Callers typically surface a user-visible system event so
   * the loss of prior memory is not silent.
   */
  onRecover?: (info: { backupPath: string; cause: unknown }) => void;
  /**
   * Invoked once when a `withDb` call is skipped because the cross-process
   * open-lock could not be acquired within the wait budget. The runner
   * surfaces this as a single user-visible system warning so two concurrent
   * duet CLIs can coexist (one degrades to no-memory) without spamming the
   * UI per skipped op.
   */
  onWarn?: (message: string) => void;
}

export async function loadStoredMemory(
  memoryPath: string | false | undefined,
  cwd: string,
  options: LoadStoredMemoryOptions = {},
): Promise<MemoryPersistenceHandle> {
  if (!memoryPath) {
    const noop = async () => {};
    return { session: undefined, embed: undefined, dispose: noop };
  }

  const resolvedPath = resolveMemoryPath(memoryPath, cwd);
  const session = new MemorySession({
    path: resolvedPath,
    openOptions: {
      // Migrations double as the corruption probe: a failure inside
      // runMigrations propagates through openPGlite's try block, which
      // moves the directory aside and starts fresh rather than wedging
      // the agent behind an opaque PGlite abort.
      init: async (db) => {
        await runMigrations(db);
      },
      ...(options.onRecover ? { onRecover: options.onRecover } : {}),
    },
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  // The backfill worker runs whenever the CLI is up. Observers and
  // reflectors write rows during turns; embeddings catch up in the
  // background within a few batches, never blocking the foreground.
  // Skipping the worker (no `embed` option) is intentional for tests
  // and one-shot tools that do not call recall_memory.
  const worker = options.embed
    ? new EmbeddingBackfillWorker({
        session,
        embed: options.embed,
        logPath: options.embeddingLogPath ?? defaultEmbeddingLogPath(),
      })
    : undefined;
  worker?.start();

  // Eager probe: open + run migrations once at startup. This keeps
  // the "fail fast on corruption" property of the old eager loader
  // (an unreadable dataDir is quarantined and onRecover is called
  // before any turn dispatches) without changing the steady-state
  // lazy-open behavior. The handle idle-closes within 2s afterwards
  // unless the contextPack rebuild below grabs it first.
  await session.withDb(async () => {});

  if (options.contextPack) {
    // Initial compaction trigger: freeze the rendered memory pack
    // before the first turn dispatches so the prefix is stable from
    // turn 1, not turn 2. Migrations ran during the probe above; the
    // 2s idle-close window means the rebuild typically rides the
    // same open. Failure here is non-fatal: the pack stays empty
    // and the runner can trigger a refresh later.
    try {
      await rebuildMemoryContextPack({
        session,
        cache: options.contextPack.cache,
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

  const dispose = async () => {
    await worker?.stop();
    await session.dispose();
  };
  return { session, embed: options.embed, dispose };
}

function defaultEmbeddingLogPath(): string {
  return join(homedir(), ".duet", "logs", "memory-backfill.log");
}

/**
 * Insert a new observation row, materializing `id`, `createdAt`, and
 * `lastUsedAt = createdAt`. Returns the populated `Observation` so
 * callers can refer to the freshly-assigned id (e.g. to keep
 * observation-group range markers consistent). Returns `undefined`
 * when the cross-process lock could not be acquired within the
 * session's wait budget — writes are silently dropped in that case so
 * a concurrent duet CLI does not crash the foreground turn.
 */
export async function appendObservation(
  session: MemorySession,
  input: Omit<Observation, "id" | "createdAt" | "lastUsedAt">,
): Promise<Observation | undefined> {
  const observation: Observation = {
    ...input,
    id: createMemoryId(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  const result = await session.withDb(async (db) => {
    await upsertObservation(db, observation);
    return observation;
  });
  return result;
}

/**
 * Replace this session's rows with the given list. Used by reflection,
 * which condenses the session's observation log into one reflection
 * row. Scoping the delete to `session_id = $1` is what makes the
 * cross-session global pool durable: another session's rows are never
 * touched by the current session's reflection. No-op when the
 * cross-process lock could not be acquired.
 */
export async function replaceSessionObservations(
  session: MemorySession,
  sessionId: string,
  observations: readonly Observation[],
): Promise<void> {
  const ids = observations.map((observation) => observation.id);
  await session.withDb(async (db) => {
    await db.transaction(async (tx) => {
      if (ids.length === 0) {
        await tx.query("DELETE FROM observations WHERE session_id = $1", [sessionId]);
      } else {
        await tx.query(
          "DELETE FROM observations WHERE session_id = $1 AND NOT (id = ANY($2::text[]))",
          [sessionId, ids],
        );
      }
      for (const observation of observations) {
        await upsertObservation(tx, observation);
      }
    });
  });
}

/**
 * Read this session's observations in chronological order along with a
 * rough token count. Used by the observer (to gate reflection on
 * cumulative session-local observation tokens) and by
 * `getUnobservedMessageTail` to find the highest message id already
 * folded into an observation-group range. Returns an empty snapshot
 * when the cross-process lock could not be acquired.
 */
export interface SessionObservationsSnapshot {
  observations: Observation[];
  estimatedObservationTokens: number;
}

/**
 * Read every observation in the durable store, regardless of session id,
 * in chronological order. Used by the cross-session reflect command
 * (`duet memory reflect`) which condenses the entire global pool into a
 * single reflection row. Returns an empty snapshot when the cross-process
 * lock could not be acquired.
 */
export async function readAllObservations(
  session: MemorySession,
): Promise<SessionObservationsSnapshot> {
  const result = await session.withDb(async (db) => {
    const queryResult = await db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       ORDER BY created_at ASC`,
    );
    const observations = queryResult.rows.map(rowToObservation);
    return {
      observations,
      estimatedObservationTokens: estimateTokens(
        observations.map((observation) => observation.content).join("\n"),
      ),
    };
  });
  return result ?? { observations: [], estimatedObservationTokens: 0 };
}

/**
 * Replace the entire observation pool (across all sessions) with the given
 * list. Used by `reflectAllObservations` — the cross-session reflect — which
 * is the only legitimate caller. Session-scoped reflection uses
 * `replaceSessionObservations` instead so it does not destroy other
 * sessions' rows. No-op when the cross-process lock could not be acquired.
 */
export async function replaceAllObservations(
  session: MemorySession,
  observations: readonly Observation[],
): Promise<void> {
  const ids = observations.map((observation) => observation.id);
  await session.withDb(async (db) => {
    await db.transaction(async (tx) => {
      if (ids.length === 0) {
        await tx.query("DELETE FROM observations");
      } else {
        await tx.query("DELETE FROM observations WHERE NOT (id = ANY($1::text[]))", [ids]);
      }
      for (const observation of observations) {
        await upsertObservation(tx, observation);
      }
    });
  });
}

export async function readSessionObservations(
  session: MemorySession,
  sessionId: string,
): Promise<SessionObservationsSnapshot> {
  const result = await session.withDb(async (db) => {
    const queryResult = await db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    const observations = queryResult.rows.map(rowToObservation);
    return {
      observations,
      estimatedObservationTokens: estimateTokens(
        observations.map((observation) => observation.content).join("\n"),
      ),
    };
  });
  return result ?? { observations: [], estimatedObservationTokens: 0 };
}

/**
 * Bump `last_used_at` for the given ids to `now`. Fire-and-forget
 * usage signal: if the model's response leaned on a particular
 * memory, that memory's ranking refreshes so it stays surfaced. No-op
 * when `ids` is empty or when the cross-process lock could not be
 * acquired.
 */
export async function bumpLastUsed(
  session: MemorySession,
  ids: readonly string[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  await session.withDb(async (db) => {
    await db.query("UPDATE observations SET last_used_at = $1 WHERE id = ANY($2::text[])", [
      now,
      ids,
    ]);
  });
}

async function upsertObservation(
  database: Pick<PGlite, "query"> | Transaction,
  observation: Observation,
): Promise<void> {
  await database.query(
    `INSERT INTO observations (
      id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date, time_of_day,
      priority, source_json, content, tags_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      created_at = EXCLUDED.created_at,
      last_used_at = EXCLUDED.last_used_at,
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
      observation.lastUsedAt,
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

function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
}

interface ObservationRow {
  id: string;
  created_at: number;
  last_used_at: number;
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
    lastUsedAt: row.last_used_at,
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
