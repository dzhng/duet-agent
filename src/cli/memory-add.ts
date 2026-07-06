import { appendObservation } from "../memory/storage.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { ObservationPriority, ObservationSource } from "../types/memory.js";
import { printMemoryAddHelp } from "./help.js";
import { toMemoryJson } from "./memory-json.js";
import { scoreObservation, withMemorySession } from "./memory-db.js";
import { PRIORITIES, parseEnum, SOURCES } from "./memory-query.js";
import { fail, resolveUserPath, usageError } from "./shared.js";

type SourceKind = ObservationSource["kind"];

interface AddCommandOptions {
  dbPath: string;
  /** Positional content joined with spaces; empty when the caller pipes via stdin instead. */
  content: string;
  priority: ObservationPriority;
  /** Provenance stamped on the row and echoed back; defaults to `user`. */
  source: SourceKind;
  tags: string[];
  /** Session that authored the row; omitted leaves the row global/unattributed. */
  sessionId?: string;
  /** Emit one canonical memory JSON object instead of the human line. */
  json: boolean;
  waitBudgetMs?: number;
}

interface AddCommandIO {
  stdout: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

/**
 * Run `duet memory add` — write a single user-added note row into the same
 * `~/.duet/memory.db` the runner reads from, so it surfaces in the next
 * session. Stored as `kind: "note"` with no `sessionId`, so it lands in the
 * cross-session global pack with a small `noteBias` bump (above reflections,
 * far below a `duet train` corpus) and stays eligible for `duet memory
 * reflect` compaction, folding like any other observation once aged.
 *
 * Content comes from the positional arguments, or from stdin when none are
 * given so callers can pipe longer text (`echo "…" | duet memory add`).
 *
 * Embeddings are not computed here; the next runner session's startup
 * backfill worker picks the row up and embeds it so `recall_memory` reaches it.
 */
export async function runMemoryAddCommand(
  args: string[],
  io: AddCommandIO = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const options = parseMemoryAddArgs(args);
  if (!options) return;

  const content = await resolveContent(options.content, io);

  const observation = await withMemorySession(
    options.dbPath,
    (session) =>
      appendObservation(session, {
        kind: "note",
        priority: options.priority,
        source: { kind: options.source },
        content,
        tags: options.tags,
        observedDate: new Date().toISOString().slice(0, 10),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      }),
    { waitBudgetMs: options.waitBudgetMs },
  );
  if (!observation) {
    fail(`Could not write memory to ${options.dbPath} (lock contention).`);
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
export function parseMemoryAddArgs(args: string[]): AddCommandOptions | undefined {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let priority: ObservationPriority = "medium";
  let source: SourceKind = "user";
  let sessionId: string | undefined;
  let json = false;
  const tags: string[] = [];
  let waitBudgetMs: number | undefined;
  const contentParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--priority":
        priority = parseEnum(args[++i], PRIORITIES, arg);
        break;
      case "--source":
        source = parseEnum(args[++i], SOURCES, arg);
        break;
      case "--session":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        sessionId = args[++i]!;
        break;
      case "--json":
        json = true;
        break;
      case "--tag":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        tags.push(args[++i]!);
        break;
      case "--wait": {
        const raw = args[++i];
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
    dbPath,
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
