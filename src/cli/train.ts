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
import type { SynthesisResult, TrainManifest } from "../train/types.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { printTrainHelp } from "./help.js";
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

  When you have read enough to write an accurate synthesis, produce
  EXACTLY one file at the cwd root and nothing else:

    \`.duet-train.json\` — a JSON object with exactly two string fields:
      {
        "headline": "<short title for this corpus, under 120 characters, no trailing punctuation>",
        "observationContent": "<one or two paragraphs of concrete, durable, high-priority knowledge an agent would need to act on this material — no preamble, no 'this corpus contains' framing, write it as a standalone memory entry>"
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
  const options = parseTrainArgs(args);
  if (!options) return;

  const folderStat = await stat(options.folder).catch(() => undefined);
  if (!folderStat || !folderStat.isDirectory()) {
    fail(`Folder not found or not a directory: ${options.folder}`);
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
    ...(options.waitBudgetMs !== undefined ? { waitBudgetMs: options.waitBudgetMs } : {}),
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

    // SELECT + DELETE share one `withDb` so the replace step is atomic
    // against peer writers and lock failure surfaces in one place.
    // Invariant after this block: exactly zero `train:<slug>` rows in the DB.
    const trainTag = `train:${options.slug}`;
    const priorIds = await session.withDb(async (db) => {
      const result = await db.query<QueriedRow>("SELECT id, tags_json FROM observations");
      const ids: string[] = [];
      for (const row of result.rows) {
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
      fail(`Could not read prior training rows from ${options.dbPath} (lock contention).`);
    }
    for (const id of priorIds) {
      await removeArchive(id);
    }

    const observedDate = new Date().toISOString().slice(0, 10);
    const observation = await appendObservation(session, {
      kind: "observation",
      priority: "high",
      source: { kind: "system" },
      content: synthesis.observationContent,
      tags: ["train", trainTag],
      observedDate,
    });
    if (!observation) {
      fail(`Could not write training memory to ${options.dbPath} (lock contention).`);
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
      fail(`Could not verify training memory at ${options.dbPath} (lock contention).`);
    }
    if (verifyRows.rows[0]?.content !== synthesis.observationContent) {
      fail(`Verification failed: observation ${observation.id} did not round-trip through the DB.`);
    }

    io.stdout.write(`Trained "${synthesis.headline}"\n`);
    io.stdout.write(`  memory id  : ${observation.id}\n`);
    io.stdout.write(`  archive    : ${archivePath}\n`);
    io.stdout.write(`  files      : ${archivedFiles.length} file(s)\n`);
    io.stdout.write(`  model      : ${resolvedModel}\n`);
    io.stdout.write(`\n${synthesis.observationContent}\n`);
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      fail(
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
