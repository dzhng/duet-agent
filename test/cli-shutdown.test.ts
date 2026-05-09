import { describe, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * The shutdown helper is exercised end-to-end (signal → handler → dispose →
 * exit code) by spawning a child Bun process. Mocking `process.on('SIGINT')`
 * inside the test runner is fragile because Bun's test harness has its own
 * signal handlers; running in a real subprocess matches production.
 */
describe("installShutdownHandlers", () => {
  testIfDocker("calls dispose on SIGINT and exits with 130", async () => {
    const result = await runHarness("SIGINT");
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toContain("disposed");
  });

  testIfDocker("calls dispose on SIGTERM and exits with 143", async () => {
    const result = await runHarness("SIGTERM");
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toContain("disposed");
  });

  testIfDocker("force-exits on a second signal without waiting for dispose", async () => {
    const result = await runHarness("SIGINT", { secondSignalAfterMs: 50, slowDisposeMs: 5000 });
    expect(result.exitCode).toBe(130);
    // Dispose was started but never got to log "disposed" because the second
    // signal short-circuited it.
    expect(result.stdout).toContain("dispose start");
    expect(result.stdout).not.toContain("disposed");
    // And critically, the test ran in well under the 5-second slowDispose.
    expect(result.elapsedMs).toBeLessThan(2000);
  });
});

interface HarnessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

async function runHarness(
  signal: "SIGINT" | "SIGTERM",
  opts: { secondSignalAfterMs?: number; slowDisposeMs?: number } = {},
): Promise<HarnessResult> {
  const dir = await mkdtemp(join(tmpdir(), "duet-shutdown-"));
  try {
    const harnessPath = join(dir, "harness.ts");
    const slowDisposeMs = opts.slowDisposeMs ?? 0;
    await writeFile(
      harnessPath,
      `
import { installShutdownHandlers } from "${shutdownModulePath()}";

let disposed = false;
const dispose = async () => {
  console.log("dispose start");
  await new Promise((resolve) => setTimeout(resolve, ${slowDisposeMs}));
  disposed = true;
  console.log("disposed");
};

installShutdownHandlers(dispose);

console.log("ready");
// Keep the event loop alive forever — the signal is the only way out.
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const start = Date.now();
    const child = spawn("bun", [harnessPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Wait for "ready" so we don't race the handler installation.
    await waitFor(() => stdout.includes("ready"), 2000);

    child.kill(signal);
    if (opts.secondSignalAfterMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, opts.secondSignalAfterMs));
      child.kill(signal);
    }

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code, sig) => {
        if (code !== null) resolve(code);
        else if (sig) resolve(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 0));
        else resolve(-1);
      });
    });

    return { exitCode, stdout, stderr, elapsedMs: Date.now() - start };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function shutdownModulePath(): string {
  // Resolve to the source file from the test's vantage point. The harness is
  // written into a temp dir, so we need an absolute path.
  return new URL("../src/cli/shutdown.ts", import.meta.url).pathname;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
