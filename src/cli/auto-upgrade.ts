import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { peekOpenLockHolderPid } from "../memory/pglite.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import { acquireFileLock, DEFAULT_STALE_LOCK_MS, releaseFileLock } from "../file-lock.js";
import {
  detectPackageManagerFromContext,
  globalUpgradeCommand,
  type PackageManager,
} from "./package-manager.js";
import { compareSemverVersions, fetchLatestPackageVersion } from "./version-check.js";

/**
 * Why this exists: the CLI ships several versions per hour. Manual `duet
 * upgrade` lags behind, so each launch probes the registry and — when a
 * newer version exists — runs the package manager's global install in the
 * background while the user is already using the TUI. The next launch is
 * then already on latest.
 *
 * Concurrency safety:
 *   - The package manager mutates the global install path in place. Already-
 *     running CLI processes do not re-read those files, so they are unaffected.
 *   - A CLI that *starts* mid-install could see partial files. We minimize
 *     that window with an exclusive lockfile so only one process upgrades at
 *     a time; others fall through and observe whatever state currently exists.
 *   - Stale locks (worker crash, OS kill) older than STALE_LOCK_MS are
 *     reclaimed so a missed unlink does not permanently disable upgrades.
 *
 * Status stream: `runAutoUpgrade` emits each transition through `onStatus`
 * so the TUI can render a live "Checking… / Upgrading… / Upgraded, restart"
 * line in the header. The returned promise resolves once the final state
 * is reached.
 */

/** Env var users set to disable the auto-upgrade entirely. */
export const NO_AUTO_UPGRADE_ENV = "DUET_NO_AUTO_UPGRADE";

/** A lock held longer than this is treated as abandoned and replaced. */
const STALE_LOCK_MS = DEFAULT_STALE_LOCK_MS;

/** How long to wait on the registry. The TUI is already up and showing a
 *  "checking…" placeholder, so we can wait longer than the legacy inline
 *  notice without making the user feel the call. */
const REGISTRY_TIMEOUT_MS = 8_000;

/**
 * Live status stream emitted while the upgrade runs. Designed so the TUI
 * can render one line that mutates in place; each variant carries the
 * fields needed to phrase the line without re-deriving them.
 */
export type UpgradeStatus =
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "upgrading"; from: string; to: string; manager: PackageManager }
  | { kind: "upgraded"; from: string; to: string; manager: PackageManager }
  | {
      kind: "failed";
      from: string;
      to: string;
      manager: PackageManager;
      error: string;
    }
  | { kind: "locked" }
  | {
      kind: "skipped";
      reason:
        | "disabled"
        | "source-checkout"
        | "registry-unreachable"
        /**
         * Another duet process holds the cross-process open-lock on
         * `~/.duet/memory.db`. npm rewriting `node_modules` mid-flight
         * while that peer is live is the documented trigger for the
         * PGlite quarantine recovery path, so we skip the upgrade
         * entirely and let the next solo-CLI launch perform it.
         */
        | "memory-in-use";
    };

export type UpgradeStatusListener = (status: UpgradeStatus) => void;

/**
 * A pub/sub handle the TUI subscribes to so it can render the live upgrade
 * line. `publish` is called once per intermediate status; `complete` is
 * called with the final status so late subscribers (e.g. the TUI mounting
 * after the upgrade already finished) still see the terminal state.
 */
export interface UpgradeStatusStream {
  subscribe(listener: UpgradeStatusListener): () => void;
  publish(status: UpgradeStatus): void;
  complete(final: UpgradeStatus): void;
  /** Latest status emitted, or undefined before the first publish. */
  current(): UpgradeStatus | undefined;
}

export function createUpgradeStatusStream(): UpgradeStatusStream {
  const listeners = new Set<UpgradeStatusListener>();
  let latest: UpgradeStatus | undefined;
  const publish = (status: UpgradeStatus): void => {
    latest = status;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // Listener errors must not break the upgrade flow.
      }
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      // Replay the most recent status so late subscribers do not miss the
      // current state — e.g. if the upgrade finished before the TUI mounted.
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    publish,
    complete(final) {
      if (latest !== final) publish(final);
    },
    current() {
      return latest;
    },
  };
}

export interface RunAutoUpgradeInput {
  packageName: string;
  currentVersion: string;
  /** Callback fired on every status transition. Never throws back into caller. */
  onStatus?: UpgradeStatusListener;
  /** Suppresses the run regardless of env (used after `--no-auto-upgrade`). */
  disabled?: boolean;
  /** process.argv[1] — used to detect source-checkout invocations. */
  scriptPath?: string;
  /** process.env at call site; lets tests inject a controlled environment. */
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to fetchLatestPackageVersion. */
  fetchLatest?: (packageName: string) => Promise<string | undefined>;
  /** Override for tests; defaults to spawning the real package manager. */
  runUpgrade?: (command: string[]) => Promise<{ ok: boolean; stderr?: string }>;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  detectManager?: () => PackageManager;
  /**
   * Path of the memory db data directory to probe before upgrading.
   * When another live duet process holds its open-lock, the upgrade is
   * skipped with reason "memory-in-use". Defaults to
   * `~/.duet/memory.db`; tests inject a scratch dir.
   */
  memoryDbPath?: string;
  /** Override for tests; defaults to `peekOpenLockHolderPid`. */
  peekMemoryHolder?: typeof peekOpenLockHolderPid;
}

/**
 * Run the auto-upgrade flow in-process. Emits status transitions through
 * `onStatus` and resolves to the final status. Never throws — every error
 * path produces a terminal status the caller can render.
 */
export async function runAutoUpgrade(input: RunAutoUpgradeInput): Promise<UpgradeStatus> {
  const emit = (status: UpgradeStatus): UpgradeStatus => {
    try {
      input.onStatus?.(status);
    } catch {
      // Listener errors must never affect the upgrade flow.
    }
    return status;
  };

  const env = input.env ?? process.env;
  if (input.disabled || env[NO_AUTO_UPGRADE_ENV] === "1") {
    return emit({ kind: "skipped", reason: "disabled" });
  }
  const scriptPath = input.scriptPath ?? process.argv[1];
  if (!scriptPath || !isLikelyGlobalInstall(scriptPath)) {
    return emit({ kind: "skipped", reason: "source-checkout" });
  }

  // Skip when another live duet process is using the memory db. Running
  // `npm install -g` against the package while a peer CLI has PGlite
  // open is the documented trigger for the `memory.db.corrupted-*`
  // recovery path (node_modules gets half-rewritten under the peer's
  // feet, its next PGlite reopen sees a torn WASM, and the retry-then-
  // quarantine fallback eventually fires). The next solo-CLI launch
  // will pick the upgrade back up.
  const memoryDbPath = input.memoryDbPath ?? DEFAULT_MEMORY_DB_PATH;
  const peekMemoryHolder = input.peekMemoryHolder ?? peekOpenLockHolderPid;
  const memoryHolderPid = peekMemoryHolder(memoryDbPath);
  if (memoryHolderPid !== null) {
    appendLog(
      `skip memory-in-use package=${input.packageName} current=${input.currentVersion} holder=${memoryHolderPid}`,
    );
    return emit({ kind: "skipped", reason: "memory-in-use" });
  }

  const now = input.now ?? (() => Date.now());
  const { duetDir, lockPath } = upgradePaths();
  ensureDir(duetDir);
  const handle = acquireFileLock(lockPath, { now: now(), staleAfterMs: STALE_LOCK_MS });
  if (handle === null) {
    appendLog(`skip locked package=${input.packageName} current=${input.currentVersion}`);
    return emit({ kind: "locked" });
  }
  try {
    // Self-heal partial installs from a previous run before we either probe
    // the registry or spawn a fresh install. npm's global install finalizes
    // with two renames — `agent` → `.agent-<rand>` (old aside), then
    // `.agent-<rand>` (new tmp) → `agent`. A SIGKILL between them (e.g. a
    // sandbox tearing down the exec process tree) leaves the scope dir with
    // a leftover `.agent-*` directory and no `agent`, so the next install
    // fails with `ENOTEMPTY` and `duet` stays missing from $PATH. Sweep
    // those stragglers while we hold the upgrade lock so concurrent CLIs do
    // not race against us.
    cleanStaleStagingDirs(scriptPath);
    emit({ kind: "checking" });
    const fetchLatest =
      input.fetchLatest ?? ((name: string) => fetchLatestPackageVersion(name, REGISTRY_TIMEOUT_MS));
    let latest: string | undefined;
    try {
      latest = await fetchLatest(input.packageName);
    } catch (error) {
      appendLog(`fetch-error package=${input.packageName} error=${describeError(error)}`);
      return emit({ kind: "skipped", reason: "registry-unreachable" });
    }
    if (!latest) {
      appendLog(`no-latest package=${input.packageName}`);
      return emit({ kind: "skipped", reason: "registry-unreachable" });
    }
    if (compareSemverVersions(latest, input.currentVersion) <= 0) {
      appendLog(`current package=${input.packageName} version=${input.currentVersion}`);
      return emit({ kind: "current", version: input.currentVersion });
    }

    const detect =
      input.detectManager ??
      (() =>
        detectPackageManagerFromContext({
          userAgent: process.env.npm_config_user_agent,
          runtimeExecutable: process.argv[0],
          scriptPath: process.argv[1],
        }));
    const manager = detect();
    emit({ kind: "upgrading", from: input.currentVersion, to: latest, manager });

    const command = globalUpgradeCommand(manager, input.packageName, latest);
    const run = input.runUpgrade ?? defaultRunUpgrade;
    const result = await run(command);
    if (result.ok) {
      appendLog(
        `upgraded package=${input.packageName} from=${input.currentVersion} to=${latest} manager=${manager}`,
      );
      return emit({ kind: "upgraded", from: input.currentVersion, to: latest, manager });
    }
    const error = result.stderr ?? "package manager exited non-zero";
    appendLog(
      `failed package=${input.packageName} from=${input.currentVersion} to=${latest} manager=${manager} stderr=${error}`,
    );
    return emit({ kind: "failed", from: input.currentVersion, to: latest, manager, error });
  } finally {
    releaseFileLock(handle);
  }
}

/**
 * Heuristic: only run auto-upgrade when the CLI looks like a globally
 * installed binary. Source-checkout runs (`bun src/cli.ts`) and per-project
 * installs are skipped so contributors never get their working copy
 * overwritten by `npm install --global`.
 */
export function isLikelyGlobalInstall(scriptPath: string): boolean {
  const normalized = scriptPath.replace(/\\/g, "/");
  if (
    normalized.includes("/.bun/install/global/") ||
    normalized.includes("/.bun/bin/") ||
    normalized.includes("/.pnpm/") ||
    normalized.includes("/share/pnpm/") ||
    normalized.includes("/.config/yarn/global/") ||
    normalized.includes("/yarn/global/")
  ) {
    return true;
  }
  // npm global installs live under `<prefix>/lib/node_modules/<pkg>/...`.
  if (/\/lib\/node_modules\//.test(normalized)) return true;
  // Volta, fnm, nvm prefixes vary; treat any `node_modules/@duetso/` as global.
  if (normalized.includes("/node_modules/@duetso/")) return true;
  return false;
}

/**
 * Human-readable one-liner for any UpgradeStatus. Used by both the JSON
 * stderr path and the TUI header so the wording stays consistent.
 */
export function describeUpgradeStatus(
  packageName: string,
  status: UpgradeStatus,
): string | undefined {
  switch (status.kind) {
    case "checking":
      return "Checking for updates…";
    case "upgrading":
      return `Updating ${packageName} ${status.from} → ${status.to}…`;
    case "upgraded":
      return `Updated ${packageName} to ${status.to}. Restart duet to use it.`;
    case "failed":
      return `Update to ${status.to} failed (${status.error}). Run: duet upgrade`;
    case "locked":
    case "current":
    case "skipped":
      // No notice — either we are on latest, another process is handling it,
      // or auto-upgrade is intentionally off. Header stays clean.
      return undefined;
  }
}

/** Resolved lazily so tests can swap $HOME per case. */
function upgradePaths(): { duetDir: string; lockPath: string; logPath: string } {
  const duetDir = join(homedir(), ".duet");
  return {
    duetDir,
    lockPath: join(duetDir, "upgrade.lock"),
    logPath: join(duetDir, "logs", "upgrade.log"),
  };
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Remove leftover `.agent-<rand>` staging directories that a previously
 * killed `npm install -g @duetso/agent` left behind in the @duetso scope
 * dir. Safe to call repeatedly; missing entries are ignored. The scope dir
 * is derived from `scriptPath` by walking up to the `@duetso/agent`
 * segment, which `isLikelyGlobalInstall` already validated above.
 */
function cleanStaleStagingDirs(scriptPath: string): void {
  const normalized = scriptPath.replace(/\\/g, "/");
  const marker = "/@duetso/agent/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return;
  // Use the original (non-normalized) path so Windows separators survive,
  // even though duet only ships on POSIX today.
  const scopeDir = scriptPath.slice(0, idx + "/@duetso".length);
  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".agent-")) continue;
    const stagingPath = join(scopeDir, entry);
    try {
      rmSync(stagingPath, { recursive: true, force: true });
      appendLog(`cleaned-staging path=${stagingPath}`);
    } catch (error) {
      appendLog(`cleaned-staging-error path=${stagingPath} error=${describeError(error)}`);
    }
  }
}

function appendLog(line: string): void {
  try {
    const { logPath } = upgradePaths();
    ensureDir(join(logPath, ".."));
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Base spawn options for the package manager upgrade. `detached: true` puts
 * npm in its own process group so a terminal Ctrl+C on the parent does not
 * propagate to the install. The full `stdio` array is composed at spawn
 * time because the stderr slot is a per-invocation file descriptor — see
 * `defaultRunUpgrade` for why a pipe would not be safe here.
 */
export const PACKAGE_MANAGER_SPAWN_OPTIONS: Pick<SpawnOptions, "detached"> = {
  detached: true,
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Path to the file we redirect the package manager's stderr into. The path
 * is stable so the next `duet` launch can surface a previous install
 * failure even though the writer was the prior process's detached child.
 */
function upgradeStderrPath(): string {
  return join(upgradePaths().duetDir, "logs", "upgrade-stderr.log");
}

/**
 * Default in-process runner for the package manager upgrade command.
 *
 * Survival contract (why this is not a `"pipe"`):
 *   The parent CLI is interactive and exits on Ctrl+C or `/exit`. If the
 *   child's stderr were a pipe owned by the parent, exiting closes the
 *   read end and npm's next stderr write trips SIGPIPE — killing the
 *   install mid-rename and leaving the global `@duetso` scope with a
 *   `.agent-<rand>` staging dir but no `agent` (so `duet` disappears from
 *   $PATH until the user reinstalls). Redirecting stderr to an inherited
 *   file fd has no reader to disconnect, so the install keeps writing
 *   after the parent is gone.
 *
 * We still want to report install errors in the `failed` status, so we
 * record the file's size before spawning and, on a non-zero exit, read the
 * tail written by this run.
 */
export function defaultRunUpgrade(
  command: string[],
  spawn: SpawnFn = nodeSpawn,
): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    const stderrPath = upgradeStderrPath();
    ensureDir(join(stderrPath, ".."));
    let stderrFd: number | undefined;
    let stderrStartByte = 0;
    try {
      stderrStartByte = statSync(stderrPath).size;
    } catch {
      // File does not exist yet; offset stays 0.
    }
    try {
      stderrFd = openSync(stderrPath, "a");
    } catch (error) {
      // If we cannot open the log file, fall back to discarding stderr so
      // the install still survives the parent exit. The failure message
      // will be generic but the upgrade itself completes.
      appendLog(`stderr-open-error path=${stderrPath} error=${describeError(error)}`);
    }
    const child = spawn(command[0]!, command.slice(1), {
      ...PACKAGE_MANAGER_SPAWN_OPTIONS,
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    });
    // We passed our fd to the child; close the parent's copy so it does not
    // pin the file open for the lifetime of this process.
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd);
      } catch {
        // ignore
      }
    }
    child.unref();
    child.once("error", (error) => {
      resolve({ ok: false, stderr: describeError(error) });
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, stderr: readStderrTail(stderrPath, stderrStartByte) });
    });
  });
}

/**
 * Read what this run appended to the shared stderr log. Capped so a long
 * npm trace does not bloat the failed-status line.
 */
function readStderrTail(path: string, startByte: number): string | undefined {
  const MAX_BYTES = 4096;
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const from = Math.max(startByte, size - MAX_BYTES);
      const length = Math.max(0, size - from);
      if (length === 0) return undefined;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, from);
      const trimmed = buf.toString("utf8").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return undefined;
  }
}

// Test-only access to internal paths and constants.
export const __testing = {
  upgradePaths,
  STALE_LOCK_MS,
  cleanStaleStagingDirs,
};
