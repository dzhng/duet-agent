import { describe, expect } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { testIfDocker } from "./helpers/docker-only.js";

describe("task-work subprocess fixture", () => {
  testIfDocker(
    "starts, emits output, remains gated, and records SIGTERM",
    async () => {
      const fixtureDir = await mkdtemp(join(tmpdir(), "duet-task-work-"));
      const startedFile = join(fixtureDir, "started");
      const pidFile = join(fixtureDir, "pid");
      const releaseFile = join(fixtureDir, "release");
      const stoppedFile = join(fixtureDir, "stopped");
      const child = spawn(
        "bun",
        [
          fixturePath(),
          "--started-file",
          startedFile,
          "--pid-file",
          pidFile,
          "--release-file",
          releaseFile,
          "--stopped-file",
          stoppedFile,
          "--stdout",
          "chosen stdout\n",
          "--stderr",
          "chosen stderr\n",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      const outputEmitted = new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.includes("chosen stdout\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (!stdout.includes("chosen stdout\n")) {
            reject(new Error(`Fixture exited before output: code=${code} signal=${signal}`));
          }
        });
      });
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

      try {
        await outputEmitted;

        expect(await readFile(startedFile, "utf8")).toBe("started\n");
        expect(await readFile(pidFile, "utf8")).toBe(`${child.pid}\n`);
        expect(child.exitCode).toBeNull();
        expect(await exists(releaseFile)).toBe(false);

        child.kill("SIGTERM");
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });

        expect(exitCode).toBe(143);
        expect(await readFile(stoppedFile, "utf8")).toBe(`SIGTERM ${child.pid}\n`);
        expect(stdout).toBe("chosen stdout\n");
        expect(stderr).toBe("chosen stderr\n");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fixturePath(): string {
  return new URL("../evals/fixtures/task-work.ts", import.meta.url).pathname;
}
