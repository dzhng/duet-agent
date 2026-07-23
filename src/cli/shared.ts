import { configuredRouterProviders } from "../model-resolution/resolver.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";
import type { TransportSnapshot } from "../connected-providers/transport-preference.js";
import { loadConnectedTokensSnapshot } from "../connected-providers/tokens.js";

/** Default location of the shared duet env file shown in CLI help text. */
export const DEFAULT_DUET_ENV_FILE = "~/.duet/.env";

/**
 * Provider API keys recognized by `duet env --keys`. One per supported model
 * router. Order is the order we prompt the user; first match wins for
 * inferred-default model resolution (mirrors `PROVIDER_ORDER`).
 */
export const SUPPORTED_API_KEYS = [
  "DUET_API_KEY",
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/**
 * Print a fatal error and exit. `exitCode` defaults to `1` (a generic runtime
 * failure); pass a specific code for the contract's distinguished exits. Used
 * by every CLI subcommand so the message format stays consistent.
 *
 * Exit-code contract:
 * - `1`: generic runtime failure (default).
 * - `64`: usage/validation error — route through {@link usageError}.
 * - `75`: memory DB lock-wait budget exhausted.
 */
export function fail(message: string, exitCode = 1): never {
  console.error(`Fatal: ${message}`);
  process.exit(exitCode);
}

/**
 * Fail with exit code `64` for a usage or validation error: an unknown flag, a
 * missing or invalid flag value, or empty required input. Kept distinct from a
 * generic {@link fail} so a caller (the Agent Drive backend) can tell a
 * bad-invocation error apart from a runtime failure without parsing stderr.
 */
export function usageError(message: string): never {
  return fail(message, 64);
}

/**
 * Resolve a path that may use `~` for the home directory and may be relative
 * to a base directory other than the cwd. Used everywhere the CLI accepts a
 * filesystem path argument (env files, system-prompt files, workdir).
 */
export function resolveUserPath(path: string, baseDir = process.cwd()): string {
  const expanded = expandHomeDir(path);
  if (expanded !== path) return expanded;
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/**
 * Expand a leading `~` or `~/` to the current user's home directory. Used
 * for path-shaped CLI args (notably `--workdir`) where we want `~` support
 * but do not want to force the value to an absolute path the way
 * {@link resolveUserPath} does. Paths without a leading `~` are returned
 * verbatim so relative working directories still resolve against the
 * spawning shell's cwd.
 */
export function expandHomeDir(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
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
/**
 * Identify Duet honestly on the codex transport (proven accepted live,
 * 2026-07-23). Reverts to pi-ai's default via DUET_CODEX_ORIGINATOR=pi.
 */
process.env.DUET_CODEX_ORIGINATOR ??= "duet";

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

let transportSnapshot: TransportSnapshot = Object.freeze({ connections: Object.freeze([]) });
let transportSnapshotLoad: Promise<void> | undefined;

/**
 * Test-only: pin or reset the process-global transport snapshot. The global
 * leaks across test files in one worker; suites that assert transport
 * choices must pin it instead of inheriting whichever file loaded first.
 */
export function setConnectedTransportSnapshotForTest(snapshot?: TransportSnapshot): void {
  transportSnapshot = Object.freeze(snapshot ?? { connections: Object.freeze([]) });
  transportSnapshotLoad = snapshot === undefined ? undefined : Promise.resolve();
}

/**
 * Read connected-provider routing state once for this CLI process and seed the
 * synchronous token cache from the same records. Later store changes become
 * visible on the next CLI invocation, keeping model resolution free of I/O.
 */
export function loadConnectedTransportSnapshot(): Promise<void> {
  transportSnapshotLoad ??= loadConnectedTokensSnapshot().then((connections) => {
    transportSnapshot = Object.freeze({
      connections: Object.freeze(
        connections.map(({ provider, eligibility }) => ({ provider, eligibility })),
      ),
      configuredRouters: Object.freeze(configuredRouterProviders()),
    });
  });
  return transportSnapshotLoad;
}

/** Immutable connected-provider routing state captured at CLI boot. */
export function connectedTransportSnapshot(): TransportSnapshot {
  return transportSnapshot;
}

/** Demote one connection for the lifetime of this CLI session without touching disk. */
export function demoteConnectedTransport(
  provider: TransportSnapshot["connections"][number]["provider"],
): void {
  transportSnapshot = Object.freeze({
    ...transportSnapshot,
    connections: Object.freeze(
      transportSnapshot.connections.map((connection) =>
        connection.provider === provider
          ? { ...connection, eligibility: "plan_ineligible" as const }
          : connection,
      ),
    ),
  });
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
