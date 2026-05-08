import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, normalizePackageVersion } from "./shared.js";

export const PACKAGE_MANAGERS = ["npm", "bun", "pnpm", "yarn"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * Hints the runtime exposes about how the CLI was invoked. Splitting these
 * out makes the detection logic easy to unit-test from synthetic contexts.
 */
export interface PackageManagerDetectionContext {
  /** $npm_config_user_agent — most reliable signal when present. */
  userAgent?: string;
  /** process.argv[0] — falls back to "bun" when the binary name suggests it. */
  runtimeExecutable?: string;
  /** Path of the CLI module file; useful for global-install heuristics. */
  cliFilePath?: string;
  /** Path of the script being executed (process.argv[1]). */
  scriptPath?: string;
}

/** Validate a CLI-supplied --manager value against the supported list. */
export function parsePackageManager(value: string): PackageManager {
  if (PACKAGE_MANAGERS.includes(value as PackageManager)) return value as PackageManager;
  fail(`Unsupported package manager: ${value}`);
}

/**
 * Detect which package manager is currently running this CLI. Used by
 * `duet upgrade` so the suggested upgrade command matches the user's
 * existing install.
 */
export function detectPackageManager(): PackageManager {
  return detectPackageManagerFromContext({
    userAgent: process.env.npm_config_user_agent,
    runtimeExecutable: process.argv[0],
    cliFilePath: fileURLToPath(import.meta.url),
    scriptPath: process.argv[1],
  });
}

export function detectPackageManagerFromContext(
  context: PackageManagerDetectionContext,
): PackageManager {
  const userAgent = context.userAgent ?? "";
  for (const packageManager of PACKAGE_MANAGERS) {
    if (userAgent.startsWith(`${packageManager}/`)) return packageManager;
  }

  for (const rawPath of [context.cliFilePath, context.scriptPath]) {
    const path = rawPath?.replace(/\\/g, "/");
    if (!path) continue;
    if (path.includes("/.bun/install/global/") || path.includes("/.bun/bin/")) return "bun";
    if (path.includes("/.pnpm/") || path.includes("/share/pnpm/")) return "pnpm";
    if (path.includes("/.config/yarn/global/") || path.includes("/yarn/global/")) return "yarn";
    if (path.includes("/node_modules/")) return "npm";
  }

  if (basename(context.runtimeExecutable ?? "").includes("bun")) return "bun";
  return "npm";
}

/**
 * Build the argv that performs a global install of `packageName@version`
 * with the given package manager. Each manager gets its own subcommand
 * shape; the CLI prints this verbatim as part of the upgrade flow.
 */
export function globalUpgradeCommand(
  packageManager: PackageManager,
  packageName: string,
  version: string,
): string[] {
  const packageSpec = `${packageName}@${normalizePackageVersion(version)}`;
  if (packageManager === "bun") return ["bun", "add", "--global", packageSpec];
  if (packageManager === "pnpm") return ["pnpm", "add", "--global", packageSpec];
  if (packageManager === "yarn") return ["yarn", "global", "add", packageSpec];
  return ["npm", "install", "--global", packageSpec];
}

/**
 * Spawn a child process inheriting stdio so the user sees the manager's
 * progress. Sets the parent exit code on non-zero exit but never throws —
 * the upgrade flow logs the failure and returns control to main().
 */
export async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: "inherit" });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode ?? 1;
  }
}
