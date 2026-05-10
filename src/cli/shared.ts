import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";

/** Default location of the shared duet env file shown in CLI help text. */
export const DEFAULT_DUET_ENV_FILE = "~/.duet/.env";

/**
 * Provider API keys recognized by `duet env --keys`. Order is the order
 * we prompt the user; first match wins for inferred-default model resolution.
 */
export const SUPPORTED_API_KEYS = [
  "DUET_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Print a fatal error and exit with code 1. Used by every CLI subcommand for
 * unrecoverable user-input errors so the message format stays consistent.
 */
export function fail(message: string): never {
  console.error(`Fatal: ${message}`);
  process.exit(1);
}

/**
 * Resolve a path that may use `~` for the home directory and may be relative
 * to a base directory other than the cwd. Used everywhere the CLI accepts a
 * filesystem path argument (env files, system-prompt files, workdir).
 */
export function resolveUserPath(path: string, baseDir = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** Resolved absolute path of the shared duet env file. */
export function defaultDuetEnvFilePath(): string {
  return resolveUserPath(DEFAULT_DUET_ENV_FILE);
}

/**
 * Ordered list of env files the CLI loads on startup. The cwd-local `.env`
 * is loaded first so workspace-specific overrides win; the shared duet env
 * file fills in the user-global defaults.
 */
export function cliEnvFilePaths(workDir: string, envFilePath?: string): string[] {
  return [
    join(workDir, ".env"),
    envFilePath ? resolveUserPath(envFilePath, workDir) : defaultDuetEnvFilePath(),
  ];
}

/**
 * Load the env files from {@link cliEnvFilePaths} into `process.env` and
 * return the set of keys that came from those files. The returned set lets
 * model resolution distinguish keys we loaded from keys the user already
 * exported in their shell.
 */
export function loadCliEnvFiles(workDir: string, envFilePath?: string): Set<string> {
  const dotenvKeys = new Set<string>();
  for (const path of cliEnvFilePaths(workDir, envFilePath)) {
    const result = dotenv.config({ path, quiet: true });
    for (const key of Object.keys(result.parsed ?? {})) {
      dotenvKeys.add(key);
    }
  }
  return dotenvKeys;
}

/** Reject negative or non-numeric values for `--resume-history-messages`. */
export function parseResumeHistoryMessages(
  value: string,
  optionName = "--resume-history-messages",
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return Number(value);
}

/** True when stdin or stdout is a TTY (heuristic for interactive sessions). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY ?? process.stdout.isTTY);
}

/** True when an existing path resolves to a regular file. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Merge the given key/value pairs into the env file at `target`, creating
 * the directory tree if needed and preserving any keys that are not being
 * updated. Values are quoted only when needed so the file remains diffable.
 */
export async function mergeEnvEntries(target: string, entries: Map<string, string>): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const existingText = (await fileExists(target)) ? await readFile(target, "utf8") : "";
  const merged = new Map(Object.entries(existingText ? dotenv.parse(existingText) : {}));
  for (const [key, value] of entries) {
    merged.set(key, value);
  }
  await writeFile(target, formatEnvEntries(merged));
}

/** Serialize a key/value map as the text payload of a dotenv file. */
export function formatEnvEntries(entries: Map<string, string>): string {
  return Array.from(entries, ([key, value]) => `${key}=${dotenvQuote(value)}`).join("\n") + "\n";
}

function dotenvQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Quote a string so it round-trips through a POSIX shell. Used to render
 * resume hints and dry-run upgrade commands the user can copy verbatim.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Strip a leading `v` from a semver-ish string and return the bare numbers. */
export function normalizePackageVersion(version: string): string {
  return version.replace(/^v/, "");
}
