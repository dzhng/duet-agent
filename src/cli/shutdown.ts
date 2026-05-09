/**
 * Hook into SIGINT/SIGTERM so the caller's `dispose` (PGlite close, MCP
 * teardown, etc.) actually runs before the process exits.
 *
 * Without this, Ctrl+C kills the process while PGlite is mid-WAL-write and
 * leaves the data directory in a state that PANICs on the next start
 * (`could not locate a valid checkpoint record`). This was the original
 * cause of the corrupted `~/.duet/memory.db` we recover in `memory/pglite.ts`.
 *
 * The handler is idempotent: a second SIGINT during shutdown short-circuits
 * to an immediate exit so impatient users can still bail out. A 5-second
 * watchdog forces exit if `dispose` itself hangs (e.g., the WASM runtime is
 * wedged).
 *
 * Returns an unregister function for callers that complete normally.
 */
export function installShutdownHandlers(dispose: () => Promise<void>): () => void {
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals) => {
    const code = signalExitCode(signal);
    if (shuttingDown) {
      // User hit Ctrl+C twice — they want out now, even if dispose is still
      // working. PGlite may be left dirty, but auto-recovery will pick it up
      // on the next start.
      process.exit(code);
    }
    shuttingDown = true;

    const watchdog = setTimeout(() => {
      process.stderr.write(`\n[duet] shutdown timed out after 5s — forcing exit.\n`);
      process.exit(code);
    }, 5000);
    watchdog.unref();

    dispose()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[duet] error during shutdown: ${message}\n`);
      })
      .finally(() => {
        clearTimeout(watchdog);
        process.exit(code);
      });
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function signalExitCode(signal: NodeJS.Signals): number {
  // Convention: 128 + signal number. SIGINT = 2, SIGTERM = 15.
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
