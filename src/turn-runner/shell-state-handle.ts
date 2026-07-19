import { spawn } from "node:child_process";

export type ShellCommandOutput = { stdout: string; stderr: string; exitCode: number };
export type ShellPartialOutput = Pick<ShellCommandOutput, "stdout" | "stderr">;

export class ShellCommandError extends Error {
  constructor(
    message: string,
    readonly output: ShellCommandOutput,
  ) {
    super(message);
    this.name = "ShellCommandError";
  }
}

export interface ShellStateHandle {
  run(): Promise<ShellCommandOutput>;
  /**
   * Abort the running command and remember why. After `run()` rejects,
   * callers consult `interruptedReason()` to tell our intentional
   * cancellation apart from other shell errors.
   */
  interrupt(reason: string): void;
  partialOutput(): ShellPartialOutput | undefined;
  /** The reason passed to `interrupt()`, or undefined if not interrupted. */
  interruptedReason(): string | undefined;
}

export function createShellStateHandle(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  successCodes?: number[];
}): ShellStateHandle {
  const abortController = new AbortController();
  let partial: ShellPartialOutput | undefined;
  let interruptedReason: string | undefined;

  return {
    run: () =>
      runShellCommand(input.command, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        signal: abortController.signal,
        successCodes: input.successCodes,
        onOutput: (output) => {
          partial = output;
        },
      }),
    interrupt: (reason) => {
      interruptedReason = reason;
      abortController.abort();
    },
    partialOutput: () => partial,
    interruptedReason: () => interruptedReason,
  };
}

export async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    signal: AbortSignal;
    successCodes?: number[];
    onOutput?: (output: ShellPartialOutput) => void;
  },
): Promise<ShellCommandOutput> {
  const successCodes = options.successCodes ?? [0];
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let settled = false;

  return await new Promise<ShellCommandOutput>((resolve, reject) => {
    const child = spawn("sh", ["-lc", command], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const output = (exitCode: number): ShellCommandOutput => ({ stdout, stderr, exitCode });
    const emitOutput = () => {
      options.onOutput?.({ stdout, stderr });
    };
    const cleanup = () => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      aborted = true;
      killProcessTree(child.pid, "SIGKILL");
    };
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid, "SIGKILL");
          }, options.timeoutMs);

    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      emitOutput();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      emitOutput();
    });
    child.on("error", (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      cleanup();
      const exitCode = typeof code === "number" ? code : signal ? 128 : 1;
      const captured = output(exitCode);
      if (aborted) {
        reject(new ShellCommandError("Command aborted.", captured));
        return;
      }
      if (timedOut) {
        reject(new ShellCommandError("Command timed out.", captured));
        return;
      }
      if (successCodes.includes(exitCode)) {
        resolve(captured);
        return;
      }
      reject(new ShellCommandError(`Command exited with code ${exitCode}.`, captured));
    });
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}
