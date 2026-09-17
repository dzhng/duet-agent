import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ExecTransport } from "./duet-rpc-client.js";

/** Result of one bounded host command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process boundary used by benchmark packaging and containers. */
export interface CommandRunner {
  run(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<CommandResult>;
  /** Start a line-oriented command whose stdin remains open for RPC. */
  stream(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): ExecTransport;
}

/** Node child-process implementation shared by benchmark integrations. */
export class LocalCommandRunner implements CommandRunner {
  async run(
    argv: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
  ): Promise<CommandResult> {
    const [command, ...args] = argv;
    if (!command) throw new Error("Cannot run an empty command.");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    return { stdout, stderr, exitCode };
  }

  stream(
    argv: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): ExecTransport {
    const [command, ...args] = argv;
    if (!command) throw new Error("Cannot stream an empty command.");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdin: {
        write: (line) =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
          }),
      },
      stdoutLines: readLines(child.stdout),
      stderrLines: readLines(child.stderr),
      kill: () => {
        child.kill("SIGKILL");
      },
      exited: new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
  }
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
  }
}
