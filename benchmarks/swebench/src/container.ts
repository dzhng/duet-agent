import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ExecTransport } from "./duet-client.js";

/** Result of one bounded host command. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable process boundary; production uses {@link LocalCommandRunner}. */
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

/** Official image identity returned by the pinned Python harness. */
export interface OfficialImage {
  image: string;
  platform: "linux/amd64";
  sizeBytes: number;
  imageId: string;
}

/** Node child-process implementation shared by packaging and Docker orchestration. */
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

/** Docker CLI owner for one isolated official SWE-bench instance container. */
export class ContainerHandle {
  private started = false;

  constructor(
    readonly name: string,
    readonly image: string,
    private readonly commands: CommandRunner = new LocalCommandRunner(),
  ) {}

  /** Start the official x86_64 image under Docker Desktop emulation. */
  async start(): Promise<void> {
    if (this.started) throw new Error(`Container ${this.name} is already started.`);
    await this.requireSuccess([
      "docker",
      "run",
      "--platform",
      "linux/amd64",
      "--detach",
      "--name",
      this.name,
      "--entrypoint",
      "sleep",
      this.image,
      "infinity",
    ]);
    this.started = true;
  }

  /** Copy a host artifact into the running container without mounting user paths. */
  async cpIn(localPath: string, containerPath: string): Promise<void> {
    this.requireStarted();
    await this.requireSuccess(["docker", "cp", localPath, `${this.name}:${containerPath}`]);
  }

  /** Run a bounded command inside the instance and capture its output. */
  async exec(
    argv: readonly string[],
    options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
  ): Promise<CommandResult> {
    this.requireStarted();
    const dockerArgs = ["docker", "exec", "--interactive"];
    if (options.cwd) dockerArgs.push("--workdir", options.cwd);
    for (const [name, value] of Object.entries(options.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      dockerArgs.push("--env", `${name}=${value}`);
    }
    dockerArgs.push(this.name, ...argv);
    return this.commands.run(dockerArgs, { stdin: options.stdin });
  }

  /** Open a streaming `docker exec -i` transport for duet RPC. */
  execStream(
    argv: readonly string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): ExecTransport {
    this.requireStarted();
    const dockerArgs = ["exec", "--interactive"];
    if (options.cwd) dockerArgs.push("--workdir", options.cwd);
    for (const [name, value] of Object.entries(options.env ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      dockerArgs.push("--env", `${name}=${value}`);
    }
    dockerArgs.push(this.name, ...argv);
    return this.commands.stream(["docker", ...dockerArgs]);
  }

  /** Stop and remove only this benchmark-owned container. */
  async stop(): Promise<void> {
    if (!this.started) return;
    const result = await this.commands.run(["docker", "rm", "--force", this.name]);
    this.started = false;
    if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
      throw commandError(["docker", "rm", "--force", this.name], result);
    }
  }

  private async requireSuccess(argv: readonly string[]): Promise<CommandResult> {
    const result = await this.commands.run(argv);
    if (result.exitCode !== 0) throw commandError(argv, result);
    return result;
  }

  private requireStarted(): void {
    if (!this.started) throw new Error(`Container ${this.name} is not started.`);
  }
}

/**
 * Ask the pinned SWE-bench package for an instance image and pre-pull its
 * explicit platform. Keeping this process boundary here prevents orchestrator
 * code from reconstructing official image names or Docker commands.
 */
export async function resolveAndPullOfficialImage(
  instanceId: string,
  options: { pythonPath: string; helperPath: string; commands?: CommandRunner },
): Promise<OfficialImage> {
  const commands = options.commands ?? new LocalCommandRunner();
  const result = await commands.run([
    options.pythonPath,
    options.helperPath,
    instanceId,
    "--pull",
    "--json",
  ]);
  if (result.exitCode !== 0) {
    throw commandError([options.pythonPath, options.helperPath, instanceId], result);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Official image helper returned invalid JSON for ${instanceId}.`, {
      cause: error,
    });
  }
  if (!isOfficialImage(value)) {
    throw new Error(`Official image helper returned an invalid record for ${instanceId}.`);
  }
  return value;
}

/** Remove exactly one image previously resolved for this benchmark. */
export async function removeOfficialImage(
  image: string,
  commands: CommandRunner = new LocalCommandRunner(),
): Promise<void> {
  const result = await commands.run(["docker", "image", "rm", image]);
  if (result.exitCode !== 0 && !result.stderr.includes("No such image")) {
    throw commandError(["docker", "image", "rm", image], result);
  }
}

function isOfficialImage(value: unknown): value is OfficialImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<OfficialImage>;
  return (
    typeof image.image === "string" &&
    image.platform === "linux/amd64" &&
    typeof image.sizeBytes === "number" &&
    Number.isFinite(image.sizeBytes) &&
    typeof image.imageId === "string"
  );
}

function commandError(argv: readonly string[], result: CommandResult): Error {
  return new Error(
    `Command failed (${result.exitCode}): ${argv.join(" ")}\n${result.stderr || result.stdout}`,
  );
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
  }
}
