import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import dedent from "dedent";

import { runMigrations } from "../memory/migrations.js";
import { MemoryLockTimeoutError } from "../memory/pglite.js";
import { MemorySession } from "../memory/session.js";
import { appendObservation } from "../memory/storage.js";
import { resolveCliModel } from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH, SessionManager } from "../session/session-manager.js";
import { collectArchiveFiles, removeArchive, writeArchive } from "../train/archive.js";
import { TRAIN_TAG, trainSlugTag } from "../train/tags.js";
import type {
  SynthesisResult,
  TrainListEntry,
  TrainManifest,
  TrainRecord,
} from "../train/types.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { printTrainHelp } from "./help.js";
import { withMemoryDb } from "./memory-db.js";
import { fail, loadCliEnvFiles, resolveUserPath } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

export interface TrainCommandOptions {
  folder: string;
  slug: string;
  /** Undefined means "resolve at run time via resolveCliModel". */
  model: string | undefined;
  dbPath: string;
  waitBudgetMs?: number;
}

interface TrainCommandIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Lowercase a base name and collapse anything that isn't a-z/0-9 into
 * single dashes so the slug can serve as a tag (`train:<slug>`) and a
 * folder name without quoting.
 */
function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseTrainArgs(args: string[]): TrainCommandOptions | undefined {
  let folder: string | undefined;
  let slugOverride: string | undefined;
  // Default model is resolved at run time via `resolveCliModel`, mirroring
  // `duet run`'s actor model selection. Env var `DUET_MODEL` is honored by
  // the resolver itself; we keep `--model` as the user's explicit override.
  let model: string | undefined;
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let waitBudgetMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--slug":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        slugOverride = args[++i]!;
        break;
      case "--model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        model = args[++i]!;
        break;
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--wait": {
        const raw = args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          fail(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = Math.round(seconds * 1000);
        break;
      }
      case "--help":
      case "-h":
        printTrainHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) fail(`Unknown train option: ${arg}`);
        if (folder !== undefined) fail(`Unexpected extra argument: ${arg}`);
        folder = arg;
    }
  }

  if (!folder) fail("duet train requires a <folder> argument");
  const resolved = path.resolve(folder);
  const slug = sanitizeSlug(slugOverride ?? path.basename(resolved));
  if (slug.length === 0) {
    fail(`Could not derive a slug from "${folder}"; pass --slug <name>`);
  }
  return {
    folder: resolved,
    slug,
    model,
    dbPath,
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}

interface QueriedRow {
  id: string;
  tags_json: string;
}

/**
 * Verbatim system prompt for the synthesis sub-agent. The agent's cwd is
 * the corpus folder, so file-reading tools resolve relative paths against
 * it directly.
 */
const TRAIN_SYSTEM_PROMPT = dedent`
  You are synthesizing a project corpus into a single durable memory
  observation.

  The working directory IS the corpus. Read every file that looks
  substantive — markdown, plain text, CSVs, PDFs, spreadsheets, images,
  source code. Skip lockfiles, build artifacts, node_modules, .git, and
  other obvious noise. Use your file-reading tools (read, ls, grep) to
  explore until you understand what this corpus is about.

  Extract EXHAUSTIVELY, not as a summary. A weaker reader of this corpus
  tends to keep the headline claim and silently drop the specifics fused
  to it — that is the failure to avoid. As you read, preserve EVERY
  load-bearing concrete fact:
    - Every number, quantity, percentage, version, and date — including
      the second and third value in any enumeration (if a fact says
      "X across A, B, and C", keep A, B, AND C, never just A).
    - Every named feature, product, option, tool, attribute, and API —
      by its exact name, not a generic paraphrase.
    - Every member of a list, and the qualifier attached to each member
      (if every option "supports both X and Y", state that for the set).
    - Exact syntax, identifiers, code values, and config snippets as
      written (e.g. a property name and its literal example value).
  Never collapse an enumeration to its first item and never generalize a
  specific into a category. When in doubt, include the detail.

  When you have read enough to write an accurate synthesis, produce
  EXACTLY one file at the cwd root and nothing else:

    \`.duet-train.json\` — a JSON object with exactly two string fields:
      {
        "headline": "<short title for this corpus, under 120 characters, no trailing punctuation>",
        "observationContent": "<dense, concrete, durable, high-priority knowledge an agent would need to act on this material. Use as much length as it takes to retain every load-bearing fact above — completeness beats brevity — but keep it a single standalone memory entry of tight prose, not a document dump. No preamble, no 'this corpus contains' framing.>"
      }

  Do NOT write \`AGENTS.md\` or any other file. The JSON handoff is the
  only deliverable. Neither field may be empty. After writing the file,
  stop. You do not need to say anything else.
`;

/**
 * Launch the duet agent inside the corpus folder and let it produce a
 * `.duet-train.json` handoff file. Returns the parsed synthesis result.
 * The handoff file is removed before launch (so a leftover from a failed
 * run can't be mistaken for fresh output) and after a successful read
 * (so it doesn't leak into the corpus or the archive).
 */
async function runAgentSynthesis(
  options: { folder: string; slug: string; model: string },
  io: TrainCommandIO,
): Promise<SynthesisResult> {
  const handoffPath = path.join(options.folder, ".duet-train.json");
  await rm(handoffPath, { force: true });

  const config: TurnRunnerConfig = {
    cwd: options.folder,
    model: options.model,
    // Don't write to the durable memory DB during synthesis; the train
    // command owns the single observation row that lands at the end.
    memoryDbPath: false,
    // Synthesis must not be steered by the corpus's own AGENTS.md (if
    // present) — the agent reads files as data, not as instructions.
    systemPromptFiles: [],
    // Avoid local user-skill drift influencing what the sub-agent does.
    skillDiscovery: { includeDefaults: false },
    systemInstructions: TRAIN_SYSTEM_PROMPT,
    mode: "agent",
  };

  const manager = new SessionManager(config);

  // Quietly surface what the sub-agent is doing so a long synthesis run
  // doesn't look frozen. We only relay tool calls (the visible work) and
  // any system-level messages; assistant text and reasoning are skipped.
  const unsubscribe = manager.subscribe(({ event }) => {
    if (event.type === "step") {
      const step = event.step;
      if (step.type === "tool_call" && step.status === "running") {
        io.stderr.write(`[agent] ${step.toolName}\n`);
      } else if (step.type === "system") {
        io.stderr.write(`[agent] ${step.message}\n`);
      }
    } else if (event.type === "system") {
      io.stderr.write(`[agent] ${event.message}\n`);
    }
  });

  try {
    const session = manager.create({
      prompt: `Synthesize the corpus in this directory. Slug: ${options.slug}.`,
    });
    const terminal = await session.waitForTerminal();
    if (terminal.type !== "complete") {
      throw new Error(`train: agent terminated with type=${terminal.type}; expected "complete"`);
    }
  } finally {
    unsubscribe();
    await manager.dispose();
  }

  const raw = await readFile(handoffPath, "utf8").catch(() => {
    throw new Error(
      `train: agent did not produce ${handoffPath}. Re-run with --model <stronger model> if the model is too small.`,
    );
  });
  await rm(handoffPath, { force: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`train: .duet-train.json was not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`train: .duet-train.json must be a JSON object, got ${typeof parsed}`);
  }
  const { headline, observationContent } = parsed as Record<string, unknown>;
  if (typeof headline !== "string" || headline.trim().length === 0) {
    throw new Error(`train: .duet-train.json missing non-empty string "headline"`);
  }
  if (typeof observationContent !== "string" || observationContent.trim().length === 0) {
    throw new Error(`train: .duet-train.json missing non-empty string "observationContent"`);
  }

  return {
    headline: headline.trim(),
    observationContent: observationContent.trim(),
  };
}

/**
 * Run `duet train <folder>` — launch a sub-agent that reads the corpus
 * and writes a structured handoff file (.duet-train.json), persist the
 * synthesized observation into durable memory (replacing any prior
 * `train:<slug>` row), archive the corpus under `~/.duet/train/<memoryId>/`,
 * and verify both side effects landed.
 */
export async function runTrainCommand(
  args: string[],
  io: TrainCommandIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  // The management subcommands are read/edit/delete siblings of the synthesis
  // command. They route before the synthesis arg parser, which would otherwise
  // treat the subcommand word as a corpus folder. Everything else falls
  // through to the default `train <folder>` create flow.
  switch (args[0]) {
    case "list":
      return runTrainListCommand(args.slice(1), io);
    case "show":
      return runTrainShowCommand(args.slice(1), io);
    case "update":
      return runTrainUpdateCommand(args.slice(1), io);
    case "delete":
      return runTrainDeleteCommand(args.slice(1), io);
  }

  const options = parseTrainArgs(args);
  if (!options) return;

  // Post-parse failures throw instead of calling `fail()`: the CLI entry
  // (`runCli`) prints them identically, while in-process callers (the
  // eval harness, the model sweep) can catch them and run their cleanup.
  const folderStat = await stat(options.folder).catch(() => undefined);
  if (!folderStat || !folderStat.isDirectory()) {
    throw new Error(`Folder not found or not a directory: ${options.folder}`);
  }

  // Resolve the model the same way `duet run` does so shorthands and
  // provider routing behave identically. Env files in the corpus folder
  // can supply provider credentials; load them before resolution.
  const dotenvKeys = loadCliEnvFiles(options.folder);
  const modelResolution = resolveCliModel(options.model, dotenvKeys);
  const resolvedModel = modelResolution.modelName;

  const session = new MemorySession({
    path: options.dbPath,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    ...(options.waitBudgetMs !== undefined ? { lockWaitBudgetMs: options.waitBudgetMs } : {}),
    idleCloseMs: 60_000,
  });
  const removeShutdownHandlers = installShutdownHandlers(() => session.dispose());

  try {
    await session.withDb(async () => {});

    io.stderr.write(`[synthesize] model=${resolvedModel}\n`);
    const synthesis = await runAgentSynthesis(
      { folder: options.folder, slug: options.slug, model: resolvedModel },
      io,
    );

    // Insert the new row BEFORE deleting priors: if the process dies
    // between the two steps the worst case is a duplicate `train:<slug>`
    // row (cleaned up by the next train run), never zero rows. The row is
    // written as `kind: "manual"` so the loader's manualBias ranks it at
    // the top of the global pack (a manual row with no sessionId never
    // matches a live session, so it lands in the global pack via the
    // loader's NULL-session handling), and `duet memory reflect`'s prune
    // preserves it by kind regardless of age.
    const trainTag = trainSlugTag(options.slug);
    const observedDate = new Date().toISOString().slice(0, 10);
    const observation = await appendObservation(session, {
      kind: "manual",
      priority: "high",
      source: { kind: "system" },
      content: synthesis.observationContent,
      tags: [TRAIN_TAG, trainTag],
      observedDate,
    });
    if (!observation) {
      throw new Error(`Could not write training memory to ${options.dbPath} (lock contention).`);
    }

    // SELECT + DELETE share one `withDb` so the replace step is atomic
    // against peer writers and lock failure surfaces in one place.
    // Invariant after this block: exactly one `train:<slug>` row — the
    // one written above.
    const priorIds = await session.withDb(async (db) => {
      const result = await db.query<QueriedRow>("SELECT id, tags_json FROM observations");
      const ids: string[] = [];
      for (const row of result.rows) {
        if (row.id === observation.id) continue;
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags_json);
        } catch {
          continue;
        }
        if (Array.isArray(tags) && tags.includes(trainTag)) {
          ids.push(row.id);
        }
      }
      for (const id of ids) {
        await db.query("DELETE FROM observations WHERE id = $1", [id]);
      }
      return ids;
    });
    if (priorIds === undefined) {
      throw new Error(
        `Could not remove prior training rows from ${options.dbPath} (lock contention); ` +
          `the new row ${observation.id} was written. Re-run train to clean up the duplicate.`,
      );
    }
    for (const id of priorIds) {
      await removeArchive(id);
    }
    const replacedSuffix = priorIds.length > 0 ? ` (replaced ${priorIds.length} prior row(s))` : "";
    io.stderr.write(`[persist] memory id=${observation.id}${replacedSuffix}\n`);

    // `runAgentSynthesis` already removed `.duet-train.json`; the
    // walker's skip list is defense in depth.
    const archivedFiles = await collectArchiveFiles(options.folder);
    const manifest: TrainManifest = {
      memoryId: observation.id,
      slug: options.slug,
      createdAt: observation.createdAt,
      sourceFolder: options.folder,
      model: resolvedModel,
      headline: synthesis.headline,
      files: archivedFiles.map((file) => ({
        relPath: file.relPath,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
    };
    const archivePath = await writeArchive({
      memoryId: observation.id,
      files: archivedFiles,
      manifest,
    });

    const verifyRows = await session.withDb(async (db) =>
      db.query<{ content: string }>("SELECT content FROM observations WHERE id = $1", [
        observation.id,
      ]),
    );
    if (verifyRows === undefined) {
      throw new Error(`Could not verify training memory at ${options.dbPath} (lock contention).`);
    }
    if (verifyRows.rows[0]?.content !== synthesis.observationContent) {
      throw new Error(
        `Verification failed: observation ${observation.id} did not round-trip through the DB.`,
      );
    }

    io.stdout.write(`Trained "${synthesis.headline}"\n`);
    io.stdout.write(`  memory id  : ${observation.id}\n`);
    io.stdout.write(`  archive    : ${archivePath}\n`);
    io.stdout.write(`  files      : ${archivedFiles.length} file(s)\n`);
    io.stdout.write(`  model      : ${resolvedModel}\n`);
    io.stdout.write(`\n${synthesis.observationContent}\n`);
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      throw new Error(
        `Memory database at ${error.dataDir} is still locked by duet pid ${error.holderPid} after ${
          error.budgetMs / 1000
        }s. Stop that process (or pass --wait <seconds> to wait longer) and retry.`,
      );
    }
    throw error;
  } finally {
    removeShutdownHandlers();
    await session.dispose();
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Render the list as an aligned text table. Pure so it is unit-testable
 *  without a database. */
export function formatTrainList(entries: TrainListEntry[]): string {
  if (entries.length === 0) {
    return "No trainings found. Run `duet train <folder>` to create one.";
  }
  const rows = entries.map((entry) => ({
    slug: entry.slug,
    headline: entry.headline ?? (entry.hasArchive ? "—" : "(archive missing)"),
    model: entry.model ?? "—",
    files: entry.fileCount === undefined ? "—" : String(entry.fileCount),
    trained: entry.observedDate,
    id: entry.memoryId,
  }));
  const headers = {
    slug: "SLUG",
    headline: "HEADLINE",
    model: "MODEL",
    files: "FILES",
    trained: "TRAINED",
    id: "MEMORY ID",
  };
  const width = (key: keyof typeof headers, cap: number) =>
    Math.min(cap, Math.max(headers[key].length, ...rows.map((row) => row[key].length)));
  const w = {
    slug: width("slug", 24),
    headline: width("headline", 48),
    model: width("model", 18),
    files: width("files", 5),
    trained: width("trained", 10),
    id: width("id", 20),
  };
  const line = (cells: typeof headers) =>
    [
      truncate(cells.slug, w.slug).padEnd(w.slug),
      truncate(cells.headline, w.headline).padEnd(w.headline),
      truncate(cells.model, w.model).padEnd(w.model),
      cells.files.padStart(w.files),
      cells.trained.padEnd(w.trained),
      cells.id,
    ].join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/** Multi-line detail view for a single training (`duet train show`). */
function formatTrainRecord(record: TrainRecord): string {
  return [
    `slug       : ${record.slug}`,
    `headline   : ${record.headline ?? "—"}`,
    `memory id  : ${record.memoryId}`,
    `model      : ${record.model ?? "—"}`,
    `files      : ${record.fileCount ?? "—"}`,
    `source     : ${record.sourceFolder ?? "—"}`,
    `trained    : ${record.observedDate}`,
    `archive    : ${record.hasArchive ? "present" : "missing"}`,
    "",
    record.content,
  ].join("\n");
}

interface TrainSubOptions {
  /** Positional slug argument; required by show/update/delete, unused by list. */
  slug?: string;
  dbPath: string;
  json: boolean;
  /** Path to the new observation text, for `update`. */
  contentFile?: string;
  waitBudgetMs?: number;
}

/**
 * Shared arg parser for the management subcommands. Each command validates
 * which fields it actually requires (e.g. `show` needs a slug, `update` also
 * needs `--content-file`); this only does the lexing.
 */
function parseTrainSubArgs(args: string[]): TrainSubOptions | undefined {
  let slug: string | undefined;
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let json = false;
  let contentFile: string | undefined;
  let waitBudgetMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--content-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        contentFile = resolveUserPath(args[++i]!);
        break;
      case "--json":
        json = true;
        break;
      case "--wait": {
        const raw = args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          fail(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = seconds * 1000;
        break;
      }
      case "--help":
      case "-h":
        printTrainHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) fail(`Unknown train option: ${arg}`);
        if (slug !== undefined) fail(`Unexpected extra argument: ${arg}`);
        slug = arg;
    }
  }
  return { slug, dbPath, json, contentFile, waitBudgetMs };
}

export async function runTrainListCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const options = parseTrainSubArgs(args);
  if (!options) return;
  if (options.slug !== undefined) fail(`Unexpected argument for train list: ${options.slug}`);
  const entries = await withMemoryDb(options.dbPath, (db) => db.listTrainings(), {
    waitBudgetMs: options.waitBudgetMs,
  });
  io.stdout.write(
    options.json ? `${JSON.stringify(entries, null, 2)}\n` : `${formatTrainList(entries)}\n`,
  );
}

export async function runTrainShowCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const options = parseTrainSubArgs(args);
  if (!options) return;
  if (!options.slug) fail("duet train show requires a <slug> argument");
  const slug = options.slug;
  const record = await withMemoryDb(options.dbPath, (db) => db.findTrainingBySlug(slug), {
    waitBudgetMs: options.waitBudgetMs,
  });
  if (!record) fail(`No training found for slug "${slug}".`);
  io.stdout.write(
    options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatTrainRecord(record)}\n`,
  );
}

export async function runTrainUpdateCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const options = parseTrainSubArgs(args);
  if (!options) return;
  if (!options.slug) fail("duet train update requires a <slug> argument");
  if (!options.contentFile) fail("duet train update requires --content-file <path>");
  const slug = options.slug;
  const content = await readFile(options.contentFile, "utf8");
  if (content.trim().length === 0) {
    fail(`Refusing to write empty content from ${options.contentFile}.`);
  }
  const updated = await withMemoryDb(
    options.dbPath,
    async (db): Promise<TrainRecord> => {
      const record = await db.findTrainingBySlug(slug);
      if (!record) fail(`No training found for slug "${slug}".`);
      await db.updateContent(record.memoryId, content);
      return { ...record, content };
    },
    { waitBudgetMs: options.waitBudgetMs },
  );
  if (options.json) {
    io.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  io.stdout.write(`Updated "${slug}" (memory id ${updated.memoryId}).\n`);
}

export async function runTrainDeleteCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const options = parseTrainSubArgs(args);
  if (!options) return;
  if (!options.slug) fail("duet train delete requires a <slug> argument");
  const slug = options.slug;
  const deleted = await withMemoryDb(
    options.dbPath,
    async (db): Promise<TrainRecord> => {
      const record = await db.findTrainingBySlug(slug);
      if (!record) fail(`No training found for slug "${slug}".`);
      await db.delete(record.memoryId);
      return record;
    },
    { waitBudgetMs: options.waitBudgetMs },
  );
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ deleted: true, slug: deleted.slug, memoryId: deleted.memoryId }, null, 2)}\n`,
    );
    return;
  }
  io.stdout.write(`Deleted "${deleted.slug}" (memory id ${deleted.memoryId}) and its archive.\n`);
}
