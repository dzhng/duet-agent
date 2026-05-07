import { spawn } from "node:child_process";
const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const TEMPLATE_PLACEHOLDER_CAPTURE_PATTERN = /^\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}$/;

export type ShellCommandOutput = { stdout: string; stderr: string; exitCode: number };

export class ShellCommandError extends Error {
  constructor(
    message: string,
    readonly output: ShellCommandOutput,
  ) {
    super(message);
    this.name = "ShellCommandError";
  }
}

export async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    signal: AbortSignal;
    successCodes?: number[];
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
    const cleanup = () => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
          }, options.timeoutMs);

    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
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

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

export function parseStructuredOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  } catch {
    return { result: trimmed };
  }
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (placeholder) => {
    const path = TEMPLATE_PLACEHOLDER_CAPTURE_PATTERN.exec(placeholder)?.[1];
    if (!path) return "";
    const value = readPath(input, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function readPath(input: Record<string, unknown>, path: string): unknown {
  let value: unknown = input;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
