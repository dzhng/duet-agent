import { execFile, type ExecException } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const TEMPLATE_PLACEHOLDER_CAPTURE_PATTERN = /^\{\{\s*input\.([A-Za-z0-9_.-]+)\s*\}\}$/;

export type ShellCommandOutput = { stdout: string; stderr: string; exitCode: number };

export async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs?: number;
    signal: AbortSignal;
    successCodes?: number[];
  },
): Promise<ShellCommandOutput> {
  try {
    const result = await execFileAsync("sh", ["-lc", command], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      signal: options.signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as ExecException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const code =
      typeof execError.code === "number"
        ? execError.code
        : typeof execError.code === "string"
          ? Number(execError.code)
          : undefined;
    if (code !== undefined && (options.successCodes ?? [0]).includes(code)) {
      return {
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? "",
        exitCode: code,
      };
    }
    throw error;
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
