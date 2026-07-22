import { randomBytes } from "node:crypto";

import { createEmbeddingClient, type EmbedFn } from "../memory/embedding.js";
import { createMemoryId } from "../memory/id.js";
import { listStore, writeEntry } from "../memory/store/store.js";
import { resolveSources, type MemorySourceFlags } from "../memory/store/sources.js";
import { appendObservation } from "../memory/storage.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { ObservationPriority, ObservationSource } from "../types/memory.js";
import { printMemoryAddHelp } from "./help.js";
import { toMemoryJson } from "./memory-json.js";
import { scoreObservation, withMemorySession } from "./memory-db.js";
import { PRIORITIES, parseEnum, SOURCES } from "./memory-query.js";
import {
  lexMemorySourceFlags,
  requireSingleExplicitWriteTarget,
  requireWriteTarget,
} from "./memory-sources.js";
import { fail, usageError } from "./shared.js";

type SourceKind = ObservationSource["kind"];

interface AddCommandOptions {
  /** Explicit backend flags; empty means flagless store discovery. */
  sourceFlags: MemorySourceFlags;
  /** Compatibility projection for callers that inspect a single selected DB. */
  dbPath: string;
  /** Positional content joined with spaces; empty when the caller pipes via stdin instead. */
  content: string;
  priority: ObservationPriority;
  /** Provenance stamped on the row and echoed back; defaults to `user`. */
  source: SourceKind;
  tags: string[];
  /** Session that authored the row; omitted leaves the row global/unattributed. */
  sessionId?: string;
  /** Emit the selected backend's JSON record instead of the human line. */
  json: boolean;
  waitBudgetMs?: number;
}

interface AddCommandIO {
  stdout: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Working directory used for relative paths and flagless source discovery. */
  cwd?: string;
  /**
   * Embedding client for the synchronous insert-time embed. Defaults to
   * the Duet endpoint client; tests inject a stub (or a throwing one) to
   * pin the embedded/degraded paths without a network call.
   */
  embed?: EmbedFn;
}

/**
 * Run `duet memory add` — write one curated note to a memory-file store or
 * the legacy observational DB. Flagless writes create the nearest agent's
 * `.agents/memories` directory. DB notes retain their ranking, reflection,
 * session-attribution, and synchronous-embedding behavior; file notes retain
 * priority/source/tags in frontmatter and are loaded through store context.
 *
 * Content comes from the positional arguments, or from stdin when none are
 * given so callers can pipe longer text (`echo "…" | duet memory add`).
 *
 * For DB targets, the embedding is written synchronously alongside the row
 * (no backfill worker runs in this one-shot process), so `duet memory recall`
 * and the next session's `recall_memory` reach it semantically right away.
 * When embeddings are unavailable the add still succeeds and the next
 * runner's backfill pass embeds the row.
 */
export async function runMemoryAddCommand(
  args: string[],
  io: AddCommandIO = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseMemoryAddArgs(args, cwd);
  if (!options) return;

  const content = await resolveContent(options.content, io);
  const sources = await resolveSources(options.sourceFlags, cwd);
  const writeTarget = requireWriteTarget(sources);
  if (writeTarget.kind === "store") {
    if (options.sessionId) usageError("--session is only supported with --db <file>.");
    await writeStoreNote(writeTarget.path, content, options, io);
    return;
  }
  const embed = io.embed ?? createEmbeddingClient();

  const observation = await withMemorySession(
    writeTarget.path,
    (session) =>
      appendObservation(
        session,
        {
          kind: "note",
          priority: options.priority,
          source: { kind: options.source },
          content,
          tags: options.tags,
          observedDate: new Date().toISOString().slice(0, 10),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        },
        { embed },
      ),
    { waitBudgetMs: options.waitBudgetMs },
  );
  if (!observation) {
    fail(`Could not write memory to ${writeTarget.path} (lock contention).`);
  }

  if (options.json) {
    // Score with a single `now`; on insert `lastUsedAt == createdAt`, so the
    // pack score reflects a freshly stored row. `relevanceScore` is absent —
    // there is no query to rank the row against on an add.
    const packScore = scoreObservation(observation, Date.now());
    io.stdout.write(`${JSON.stringify(toMemoryJson(observation, { packScore }), null, 2)}\n`);
    return;
  }

  const tagSuffix = observation.tags.length > 0 ? ` [${observation.tags.join(", ")}]` : "";
  io.stdout.write(
    `Added ${observation.priority}-priority memory ${observation.id} (${observation.observedDate})${tagSuffix}\n`,
  );
}

/**
 * Parse `duet memory add` flags and positional content. Returns `undefined`
 * when `--help` was handled. Pure (no I/O) so it can be unit-tested; stdin
 * fallback for empty content happens later in {@link resolveContent}.
 */
export function parseMemoryAddArgs(
  args: string[],
  cwd: string = process.cwd(),
): AddCommandOptions | undefined {
  const sourceArgs = lexMemorySourceFlags(args, cwd);
  requireSingleExplicitWriteTarget(sourceArgs.flags);
  let priority: ObservationPriority = "medium";
  let source: SourceKind = "user";
  let sessionId: string | undefined;
  let json = false;
  const tags: string[] = [];
  let waitBudgetMs: number | undefined;
  const contentParts: string[] = [];

  for (let i = 0; i < sourceArgs.args.length; i++) {
    const arg = sourceArgs.args[i]!;
    switch (arg) {
      case "--priority":
        priority = parseEnum(sourceArgs.args[++i], PRIORITIES, arg);
        break;
      case "--source":
        source = parseEnum(sourceArgs.args[++i], SOURCES, arg);
        break;
      case "--session":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        sessionId = sourceArgs.args[++i]!;
        break;
      case "--json":
        json = true;
        break;
      case "--tag":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        tags.push(sourceArgs.args[++i]!);
        break;
      case "--wait": {
        const raw = sourceArgs.args[++i];
        const seconds = Number(raw);
        if (!raw || !Number.isFinite(seconds) || seconds < 0) {
          usageError(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = Math.round(seconds * 1000);
        break;
      }
      case "--help":
      case "-h":
        printMemoryAddHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) usageError(`Unknown add option: ${arg}`);
        contentParts.push(arg);
    }
  }

  return {
    sourceFlags: sourceArgs.flags,
    dbPath: sourceArgs.flags.dbs[0] ?? DEFAULT_MEMORY_DB_PATH,
    content: contentParts.join(" ").trim(),
    priority,
    source,
    tags,
    json,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}

/**
 * Resolve the memory text: positional content when present, otherwise stdin
 * so longer memories can be piped in. A TTY with no content is a usage error
 * rather than an indefinite wait, and empty resolved content is rejected.
 */
async function resolveContent(positional: string, io: AddCommandIO): Promise<string> {
  let content = positional;
  if (content.length === 0) {
    if (io.stdin.isTTY) {
      usageError("No memory content provided. Pass it as an argument or pipe via stdin.");
    }
    content = (await readStream(io.stdin)).trim();
  }
  if (content.length === 0) usageError("Refusing to add an empty memory.");
  return content;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeStoreNote(
  storeDir: string,
  content: string,
  options: AddCommandOptions,
  io: AddCommandIO,
): Promise<void> {
  const slug = await createNoteSlug(storeDir, content);
  const id = createMemoryId();
  const createdAt = Date.now();
  const stored = await writeEntry(storeDir, {
    slug,
    version: 1,
    id,
    kind: "note",
    createdAt,
    priority: options.priority,
    source: options.source,
    tags: options.tags,
    content,
  });

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          slug: stored.slug,
          id: stored.id,
          kind: stored.kind,
          createdAt: new Date(stored.createdAt).toISOString(),
          content: stored.content,
          priority: options.priority,
          source: options.source,
          tags: options.tags,
          store: stored.storeDir,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const tagSuffix = options.tags.length > 0 ? ` [${options.tags.join(", ")}]` : "";
  io.stdout.write(
    `Added ${options.priority}-priority memory ${stored.id} as ${stored.slug} (${new Date(createdAt)
      .toISOString()
      .slice(0, 10)})${tagSuffix}\n`,
  );
}

async function createNoteSlug(storeDir: string, content: string): Promise<string> {
  const words =
    content
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, 5) ?? [];
  const stem = (words.join("-") || "note").slice(0, 48).replace(/-+$/g, "") || "note";
  const existing = new Set((await listStore(storeDir)).map((entry) => entry.slug));
  while (true) {
    const slug = `${stem}-${randomBytes(3).toString("hex")}`;
    if (!existing.has(slug)) return slug;
  }
}
