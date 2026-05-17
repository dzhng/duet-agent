import { runMigrations } from "../memory/migrations.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  reflectAllObservations,
  resolveObservationalMemorySettings,
} from "../memory/observational.js";
import { MemoryLockTimeoutError } from "../memory/pglite.js";
import { MemorySession } from "../memory/session.js";
import { readAllObservations } from "../memory/storage.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import { printMemoryReflectHelp } from "./help.js";
import { fail, resolveUserPath } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

interface ReflectCommandOptions {
  dbPath: string;
  dryRun: boolean;
  targetTokens?: number;
  model: string;
  effectiveContext: number;
  waitBudgetMs?: number;
}

interface ReflectCommandIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Run `duet memory reflect` — read every observation in the durable store,
 * condense them through the reflector, and replace the entire pool with one
 * reflection row. Intended as a manual prune tool; the session-scoped
 * reflection that runs automatically during turns is unaffected.
 */
export async function runMemoryReflectCommand(
  args: string[],
  io: ReflectCommandIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const options = parseArgs(args);
  if (!options) return;

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
    // Eager probe so corruption / lock errors surface before the model call.
    await session.withDb(async () => {});

    const snapshot = await readAllObservations(session);
    if (snapshot.observations.length === 0) {
      io.stdout.write(`No observations to reflect at ${options.dbPath}\n`);
      return;
    }
    const settings = resolveObservationalMemorySettings(options.effectiveContext);
    const targetTokens = options.targetTokens ?? settings.reflection.bufferActivation;
    io.stdout.write(
      `Reflecting ${snapshot.observations.length} observations (~${snapshot.estimatedObservationTokens} tokens) ` +
        `into <= ${targetTokens} tokens using ${options.model}` +
        (options.dryRun ? " [dry-run]" : "") +
        "\n",
    );

    const result = await reflectAllObservations({
      session,
      snapshot,
      settings,
      model: options.model,
      targetTokens,
      dryRun: options.dryRun,
    });

    if (!result) {
      io.stdout.write("Nothing to reflect.\n");
      return;
    }

    io.stdout.write("\n--- Reflected observations ---\n");
    io.stdout.write(`${result.reflection.content.trim()}\n`);
    io.stdout.write("--- end ---\n");
    if (result.written) {
      io.stdout.write(
        `\nReplaced ${result.before.length} observation(s) with 1 reflection row (id=${result.reflection.id}).\n`,
      );
    } else {
      io.stdout.write(`\nDry-run: ${result.before.length} observation(s) left untouched.\n`);
    }
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

function parseArgs(args: string[]): ReflectCommandOptions | undefined {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let dryRun = false;
  let targetTokens: number | undefined;
  let model = process.env.DUET_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
  let effectiveContext = DEFAULT_EFFECTIVE_CONTEXT;
  let waitBudgetMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--target-tokens": {
        const raw = args[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0)
          fail(`Invalid --target-tokens value: ${raw} (expected positive number)`);
        targetTokens = Math.floor(n);
        break;
      }
      case "--model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${arg}`);
        model = args[++i]!;
        break;
      case "--effective-context": {
        const raw = args[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0)
          fail(`Invalid --effective-context value: ${raw} (expected positive number)`);
        effectiveContext = Math.floor(n);
        break;
      }
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
        printMemoryReflectHelp();
        return undefined;
      default:
        fail(`Unknown reflect option: ${arg}`);
    }
  }

  return {
    dbPath,
    dryRun,
    ...(targetTokens !== undefined ? { targetTokens } : {}),
    model,
    effectiveContext,
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}
