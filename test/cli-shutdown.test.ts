import { describe, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  testIfDocker(
    "reaps a TurnRunner-owned process group before RPC-style shutdown exits",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-shutdown-reaper-"));
      try {
        const harnessPath = join(dir, "reaper-harness.ts");
        const pidPath = join(dir, "task.pid");
        await writeFile(
          harnessPath,
          `
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { TurnRunner } from "${turnRunnerModulePath()}";
import { installShutdownHandlers } from "${shutdownModulePath()}";

class ReaperRunner extends TurnRunner {
  async startProcess(pidPath: string): Promise<void> {
    const child = spawn("bun", ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("child pid unavailable");
    await writeFile(pidPath, String(child.pid), "utf8");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.taskManager.start({
      kind: "tool",
      name: "shutdown-fixture",
      label: "Shutdown fixture",
      ownerScopeId: "shutdown-test",
      execute: async () => {
        await exited;
        return "reaped";
      },
    });
    this.taskManager.registerReaper(async () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      await exited;
    });
  }
}

const runner = new ReaperRunner({
  model: "anthropic:claude-opus-4-7",
  memoryDbPath: false,
  systemPromptFiles: [],
  skillDiscovery: { includeDefaults: false },
});
await runner.start({ type: "start", mode: "agent" });
await runner.startProcess(process.argv[2]!);
installShutdownHandlers(() => runner.dispose());
console.log("ready");
setInterval(() => {}, 1000);
`,
          "utf8",
        );

        const harness = spawn("bun", [harnessPath, pidPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        harness.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        await waitFor(() => stdout.includes("ready"), 5_000);
        const taskPid = Number((await readFile(pidPath, "utf8")).trim());

        harness.kill("SIGTERM");
        const exitCode = await new Promise<number>((resolve) => {
          harness.once("exit", (code, signal) =>
            resolve(code ?? (signal === "SIGTERM" ? 143 : -1)),
          );
        });

        expect(exitCode).toBe(143);
        await waitFor(() => !processExists(taskPid), 2_000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
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

function turnRunnerModulePath(): string {
  return new URL("../src/turn-runner/turn-runner.ts", import.meta.url).pathname;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
