import { MemoryLockTimeoutError } from "../memory/pglite.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import { printMemoryHelp } from "./help.js";
import { MemoryDb } from "./memory-db.js";
import { runMemoryTui } from "./memory-tui.js";
import { fail, resolveUserPath } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

/**
 * Run `duet memory` (alias: `duet memories`) — open the memory database in a TUI for browsing,
 * editing, and deleting durable observations.
 *
 * Defaults to the same `~/.duet/memory.db` the runner writes to so changes
 * propagate to the next session immediately.
 */
export async function runMemoryCommand(args: string[]): Promise<void> {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  // Wait budget for the cross-process open-lock, in seconds. Defaults to the shared
  // `DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS` (30s) inside `MemoryDb.open`; `--wait 0` opts out
  // entirely for scripts that prefer an immediate failure when a peer is holding the lock.
  let waitBudgetMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--wait": {
        const raw = args[i + 1];
        if (!raw || raw.startsWith("-")) fail(`Missing value for ${args[i]}`);
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          fail(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = Math.round(seconds * 1000);
        i++;
        break;
      }
      case "--help":
      case "-h":
        printMemoryHelp();
        return;
      default:
        fail(`Unknown memory option: ${args[i]}`);
    }
  }

  let db: MemoryDb;
  try {
    db = await MemoryDb.open(dbPath, waitBudgetMs === undefined ? {} : { waitBudgetMs });
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
