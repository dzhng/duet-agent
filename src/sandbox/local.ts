import { exec as execCb } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { ExecResult, Sandbox, SandboxOptions } from "../core/types.js";

const execAsync = promisify(execCb);

/**
 * Local sandbox: executes bash commands on the host machine.
 *
 * For production use, this should be replaced with an isolated sandbox
 * (e2b, Docker, Firecracker, etc). The interface is the same — just bash.
 *
 * "No MCP, everything is files and CLI."
 */
export class LocalSandbox implements Sandbox {
  constructor(
    private readonly rootDir: string,
    private readonly defaultEnv: Record<string, string> = {},
  ) {}

  async exec(command: string, options?: SandboxOptions): Promise<ExecResult> {
    const cwd = options?.cwd ?? this.rootDir;
    const env = { ...process.env, ...this.defaultEnv, ...options?.env };
    const timeoutMs = options?.timeoutMs ?? 30_000;

    const start = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        shell: "/bin/bash",
      });

      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        killed: false,
      };
    } catch (err: any) {
      return {
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        durationMs: Date.now() - start,
        killed: err.killed ?? false,
      };
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = this.resolve(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    const dir = cwd ?? this.rootDir;
    const { stdout } = await this.exec(
      `find ${dir} -path '${pattern}' -type f 2>/dev/null | head -100`,
    );
    return stdout.trim().split("\n").filter(Boolean);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    // Local sandbox: nothing to clean up.
    // Isolated sandbox implementations would tear down the container here.
  }

  private resolve(path: string): string {
    if (path.startsWith("/")) return path;
    return `${this.rootDir}/${path}`;
  }
}
