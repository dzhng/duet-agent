import { createEmbeddingClient, type EmbedFn } from "../memory/embedding.js";
import { recallMemoryExpanded, type RecallScope } from "../memory/recall.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { Observation } from "../types/memory.js";
import { printMemoryRecallHelp } from "./help.js";
import { scoreObservation, withMemorySession } from "./memory-db.js";
import { toMemoryJson } from "./memory-json.js";
import { resolveUserPath, usageError } from "./shared.js";

interface RecallCommandOptions {
  dbPath: string;
  /** Search text from `--query <q>` or positional args, joined with spaces. */
  query: string;
  scope: RecallScope;
  /** Session id used to evaluate `--scope session|global`; ignored for `all`. */
  sessionId?: string;
  limit: number;
  /** Run paraphrase expansion before fusion. Off by default to keep it cheap. */
  expand: boolean;
  /** Model used to generate paraphrases when `--expand` is set. */
  model: string;
  json: boolean;
  waitBudgetMs?: number;
}

interface RecallCommandIO {
  stdout: NodeJS.WritableStream;
  /**
   * Embedding client for the vector path. Defaults to the Duet endpoint
   * client; tests inject a stub (or a throwing one) to exercise fusion and
   * the keyword-only fallback without a network call.
   */
  embed?: EmbedFn;
}

const SCOPES: readonly RecallScope[] = ["session", "global", "all"];

/**
 * Run `duet memory recall <query>` — the CLI surface over the same hybrid
 * retrieval pipeline the runner's `recall_memory` tool uses. Both call
 * {@link recallMemoryExpanded}, so a query returns the same fused ranking
 * whether it comes from the model mid-turn or from the shell.
 *
 * Embeddings come from the Duet endpoint via {@link createEmbeddingClient};
 * when `DUET_API_KEY` is unset the vector path degrades to keyword-only and
 * the output is flagged as such, matching the tool's fallback. Passing
 * `--expand` adds model-generated paraphrases (default {@link
 * DEFAULT_CLI_MEMORY_MODEL}) before fusion, again matching the tool.
 */
export async function runMemoryRecallCommand(
  args: string[],
  io: RecallCommandIO = { stdout: process.stdout },
): Promise<void> {
  const options = parseMemoryRecallArgs(args);
  if (!options) return;

  const embed = io.embed ?? createEmbeddingClient();

  const result = await withMemorySession(
    options.dbPath,
    (session) =>
      recallMemoryExpanded({
        session,
        embed,
        query: options.query,
        limit: options.limit,
        scope: options.scope,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.expand ? { expansionModel: options.model } : {}),
      }),
    { waitBudgetMs: options.waitBudgetMs },
  );

  if (options.json) {
    // A single `now` so every row's pack score is computed against the same
    // clock, then attach the fused relevance score the pipeline already
    // returned per id. Emitted as a bare array of canonical memory objects,
    // ordered best-first, matching the `duet memory` query output.
    const now = Date.now();
    const rows = result.observations.map((observation) =>
      toMemoryJson(observation, {
        packScore: scoreObservation(observation, now),
        ...(result.relevanceById.has(observation.id)
          ? { relevanceScore: result.relevanceById.get(observation.id)! }
          : {}),
      }),
    );
    io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  // Degraded only when the vector path actually failed (embed threw or
  // the query errored). Zero vector hits from a healthy index are a
  // successful search and must not print the fallback notice.
  const degraded = result.vectorSearchAttempted && !result.vectorSearchSucceeded;
  if (degraded) {
    io.stdout.write(
      "Semantic search unavailable (keyword-only fallback). Run `duet login` to enable hybrid retrieval.\n",
    );
  }
  io.stdout.write(`${formatRecallTable(result.observations)}\n`);
}

/**
 * Parse `duet memory recall` flags and positional query. Pure (no I/O) so it
 * can be unit-tested. Returns `undefined` when `--help` was handled.
 */
export function parseMemoryRecallArgs(args: string[]): RecallCommandOptions | undefined {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let scope: RecallScope = "all";
  let sessionId: string | undefined;
  let limit = 8;
  let expand = false;
  let model = DEFAULT_CLI_MEMORY_MODEL;
  let json = false;
  let waitBudgetMs: number | undefined;
  const queryParts: string[] = [];
  let flagQuery: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--scope": {
        const raw = args[++i];
        if (!raw || !SCOPES.includes(raw as RecallScope)) {
          usageError(`Invalid --scope value: ${raw} (expected one of ${SCOPES.join(", ")})`);
        }
        scope = raw as RecallScope;
        break;
      }
      case "--session":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        sessionId = args[++i]!;
        break;
      case "--query":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        flagQuery = args[++i]!;
        break;
      case "--limit": {
        const raw = args[++i];
        const value = Number(raw);
        if (!raw || !Number.isInteger(value) || value < 1) {
          usageError(`Invalid --limit value: ${raw} (expected a positive integer)`);
        }
        limit = value;
        break;
      }
      case "--expand":
        expand = true;
        break;
      case "--model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        model = args[++i]!;
        break;
      case "--json":
        json = true;
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
        printMemoryRecallHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) usageError(`Unknown recall option: ${arg}`);
        queryParts.push(arg);
    }
  }

  // `--query` and positional args are both accepted; positional is the
  // human-friendly form. When both are present they combine, with the
  // explicit flag first.
  const query = [flagQuery, queryParts.join(" ")]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (query.length === 0) {
    usageError(
      "No query provided. Pass the text to recall, e.g. `duet memory recall wire budget cap`.",
    );
  }
  // session/global scope filter is a no-op without an id to compare against,
  // so require one rather than silently returning an unfiltered (or empty)
  // result set.
  if ((scope === "session" || scope === "global") && !sessionId) {
    usageError(`--scope ${scope} requires --session <id> to compare against.`);
  }

  return {
    dbPath,
    query,
    scope,
    ...(sessionId ? { sessionId } : {}),
    limit,
    expand,
    model,
    json,
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Render fused recall hits as an aligned table. Rows are printed in ranked
 * order (best match first), so a RANK column carries the ordering rather than
 * the global-pack `score` the filter-query path prints.
 */
export function formatRecallTable(observations: Observation[]): string {
  if (observations.length === 0) {
    return "No memories matched. Try different words, `--expand`, or a wider `--scope`.";
  }
  const rows = observations.map((o, index) => ({
    rank: String(index + 1),
    created: new Date(o.createdAt).toISOString().slice(0, 10),
    kind: o.kind,
    priority: o.priority,
    source: o.source.kind,
    content: truncate(o.content, 70),
    id: o.id,
  }));
  const headers = {
    rank: "#",
    created: "CREATED",
    kind: "KIND",
    priority: "PRIORITY",
    source: "SOURCE",
    content: "CONTENT",
    id: "MEMORY ID",
  };
  const width = (key: keyof typeof headers, cap: number) =>
    Math.min(cap, Math.max(headers[key].length, ...rows.map((row) => row[key].length)));
  const w = {
    rank: width("rank", 3),
    created: width("created", 10),
    kind: width("kind", 11),
    priority: width("priority", 8),
    source: width("source", 6),
    content: width("content", 70),
    id: width("id", 20),
  };
  const line = (cells: typeof headers) =>
    [
      cells.rank.padStart(w.rank),
      cells.created.padEnd(w.created),
      cells.kind.padEnd(w.kind),
      cells.priority.padEnd(w.priority),
      cells.source.padEnd(w.source),
      truncate(cells.content, w.content).padEnd(w.content),
      cells.id,
    ].join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}
