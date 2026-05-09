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

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--help":
      case "-h":
        printMemoryHelp();
        return;
      default:
        fail(`Unknown memory option: ${args[i]}`);
    }
  }

  const db = await MemoryDb.open(dbPath);
  const removeShutdownHandlers = installShutdownHandlers(() => db.close());
  try {
    await runMemoryTui(db, dbPath);
  } finally {
    removeShutdownHandlers();
    await db.close();
  }
}
