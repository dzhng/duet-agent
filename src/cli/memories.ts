import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import { printMemoriesHelp } from "./help.js";
import { MemoryDb } from "./memories-db.js";
import { runMemoriesTui } from "./memories-tui.js";
import { fail, resolveUserPath } from "./shared.js";

/**
 * Run `duet memories` — open the memory database in a TUI for browsing,
 * editing, and deleting durable observations.
 *
 * Defaults to the same `~/.duet/memory.db` the runner writes to so changes
 * propagate to the next session immediately.
 */
export async function runMemoriesCommand(args: string[]): Promise<void> {
  let dbPath = DEFAULT_MEMORY_DB_PATH;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      case "--help":
      case "-h":
        printMemoriesHelp();
        return;
      default:
        fail(`Unknown memories option: ${args[i]}`);
    }
  }

  const db = await MemoryDb.open(dbPath);
  try {
    await runMemoriesTui(db, dbPath);
  } finally {
    await db.close();
  }
}
