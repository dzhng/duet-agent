import { MemoryLockTimeoutError } from "../memory/pglite.js";
import { runMemoryAddCommand } from "./memory-add.js";
import { MemoryDb } from "./memory-db.js";
import { parseMemoryArgs, runMemoryQuery } from "./memory-query.js";
import { runMemoryReflectCommand } from "./memory-reflect.js";
import { runMemoryTui } from "./memory-tui.js";
import { fail } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

/**
 * Run `duet memory` (alias: `duet memories`).
 *
 * One entry point for fetching and viewing durable memories: bare `duet
 * memory` opens the interactive TUI for browsing/editing/deleting, while
 * passing `--json` or any filter flag (`--type`/`--kind`/`--priority`/
 * `--source`/`--from`/`--to`) turns the same invocation into a non-TUI,
 * scriptable query. `duet memory reflect` remains a separate subcommand.
 *
 * Defaults to the same `~/.duet/memory.db` the runner writes to so changes
 * propagate to the next session immediately.
 */
export async function runMemoryCommand(args: string[]): Promise<void> {
  if (args[0] === "reflect") {
    await runMemoryReflectCommand(args.slice(1));
    return;
  }

  if (args[0] === "add") {
    await runMemoryAddCommand(args.slice(1));
    return;
  }

  const options = parseMemoryArgs(args);
  if (!options) return;

  if (options.queryMode) {
    await runMemoryQuery(options);
    return;
  }

  const { dbPath, waitBudgetMs } = options;
  let db: MemoryDb;
  try {
    db = await MemoryDb.open(dbPath, { waitBudgetMs });
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      fail(
        `Memory database at ${error.dataDir} is still locked by duet pid ${error.holderPid} after ${
          error.budgetMs / 1000
        }s. Stop that process (or pass --wait <seconds> to wait longer) and retry.`,
      );
    }
    throw error;
  }
  const removeShutdownHandlers = installShutdownHandlers(() => db.close());
  try {
    await runMemoryTui(db, dbPath);
  } finally {
    removeShutdownHandlers();
    await db.close();
  }
}
