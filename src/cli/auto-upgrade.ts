import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const STALE_LOCK_MS = 10 * 60 * 1000;

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
      reason: "disabled" | "source-checkout" | "registry-unreachable";
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

  const now = input.now ?? (() => Date.now());
  const handle = acquireLock(now());
  if (handle === null) {
    appendLog(`skip locked package=${input.packageName} current=${input.currentVersion}`);
    return emit({ kind: "locked" });
  }
  try {
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
    releaseLock(handle);
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

interface LockPayload {
  pid: number;
  startedAt: number;
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

function acquireLock(now: number): { fd: number; lockPath: string } | null {
  const { duetDir, lockPath } = upgradePaths();
  ensureDir(duetDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now } satisfies LockPayload));
      return { fd, lockPath };
    } catch (error: any) {
      if (error?.code !== "EEXIST") return null;
      if (!isStaleLock(lockPath, now)) return null;
      try {
        unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isStaleLock(lockPath: string, now: number): boolean {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const payload = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof payload.startedAt !== "number") return true;
    return now - payload.startedAt > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function releaseLock(handle: { fd: number; lockPath: string }): void {
  try {
    closeSync(handle.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // ignore
  }
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // ignore
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
 * Spawn options chosen so the install survives the parent CLI exiting:
 *   - `detached: true` puts npm in its own process group so a terminal
 *     Ctrl+C on the parent does not propagate and abort the install
 *     mid-write (which would leave the global node_modules tree corrupt).
 *   - The returned child is also `unref()`d (and so is its stderr pipe)
 *     so a clean `/exit` returns the shell immediately and the install
 *     continues independently. The parent still observes the child's exit
 *     event for as long as it is alive, so the TUI can render the
 *     "Updated… restart duet" line when the user stays.
 */
export const PACKAGE_MANAGER_SPAWN_OPTIONS: SpawnOptions = {
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Default in-process runner for the package manager upgrade command.
 * Exported so tests can verify the spawn contract (detached, unref'd) by
 * injecting a fake spawn.
 */
export function defaultRunUpgrade(
  command: string[],
  spawn: SpawnFn = nodeSpawn,
): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), PACKAGE_MANAGER_SPAWN_OPTIONS);
    child.unref();
    // The stderr pipe is a separate libuv handle that also pins the event
    // loop alive; unref it so /exit returns even while the install is still
    // streaming output. Node exposes `unref` on the underlying socket; cast
    // because @types/node does not surface it on the Readable interface.
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      resolve({ ok: false, stderr: describeError(error) });
    });
    child.once("exit", (code) => {
      resolve({ ok: code === 0, stderr: stderr.trim() || undefined });
    });
  });
}

// Test-only access to internal paths and constants.
export const __testing = {
  upgradePaths,
  STALE_LOCK_MS,
};
