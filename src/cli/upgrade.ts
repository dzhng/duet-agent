import { peekOpenLockHolderPid } from "../memory/pglite.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import {
  detectPackageManager,
  globalUpgradeCommand,
  type PackageManager,
  parsePackageManager,
  runCommand,
} from "./package-manager.js";
import { fail, normalizePackageVersion, shellQuote } from "./shared.js";
import { fetchLatestPackageVersion } from "./version-check.js";
import { printUpgradeHelp } from "./help.js";

/**
 * Run `duet upgrade`.
 *
 * Resolves the target version (npm latest unless --version overrides),
 * builds the right global-install command for the detected manager,
 * prints it under --dry-run, and otherwise spawns it inheriting stdio.
 */
export interface UpgradeCommandOptions {
  /** Override for tests; defaults to `peekOpenLockHolderPid`. */
  peekMemoryHolder?: typeof peekOpenLockHolderPid;
  /** Override for tests; defaults to `DEFAULT_MEMORY_DB_PATH`. */
  memoryDbPath?: string;
}

export async function runUpgradeCommand(
  args: string[],
  packageName: string,
  options: UpgradeCommandOptions = {},
): Promise<void> {
  let packageManager: PackageManager = detectPackageManager();
  let dryRun = false;
  let force = false;
  let targetVersion: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manager":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        packageManager = parsePackageManager(args[++i]!);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--version":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        targetVersion = normalizePackageVersion(args[++i]!);
        break;
      case "--help":
      case "-h":
        printUpgradeHelp(packageName);
        return;
      default:
        fail(`Unknown upgrade option: ${args[i]}`);
    }
  }

  if (!targetVersion) {
    targetVersion = await resolveLatestVersionForUpgrade(packageName);
  }
  const command = globalUpgradeCommand(packageManager, packageName, targetVersion);
  const commandText = command.map(shellQuote).join(" ");
  if (dryRun) {
    console.log(commandText);
    return;
  }

  // Refuse to run while another duet CLI holds the memory db open. npm
  // rewriting `node_modules` mid-flight under a live peer is the
  // documented trigger for the `memory.db.corrupted-*` recovery path —
  // surface that as an actionable error instead of letting the user
  // re-create the corruption they just recovered from. `--force` is the
  // escape hatch for the rare case where the user knows what they are
  // doing (e.g. peer is wedged and they accept the risk).
  if (!force) {
    const peek = options.peekMemoryHolder ?? peekOpenLockHolderPid;
    const memoryDbPath = options.memoryDbPath ?? DEFAULT_MEMORY_DB_PATH;
    const holderPid = peek(memoryDbPath);
    if (holderPid !== null) {
      fail(
        `Another duet process (pid ${holderPid}) is using ${memoryDbPath}. ` +
          `Quit it first, or rerun with --force to upgrade anyway (risks corrupting the memory db).`,
      );
    }
  }

  console.error(`Upgrading ${packageName} to ${targetVersion} with ${packageManager}...`);
  await runCommand(command[0]!, command.slice(1));
}

// Foreground npm registry lookup for `duet upgrade`. Uses a generous timeout
// (the user is actively waiting) and translates aborts/network failures into
// an actionable message that points at the `--version` escape hatch.
const UPGRADE_REGISTRY_TIMEOUT_MS = 10_000;

async function resolveLatestVersionForUpgrade(packageName: string): Promise<string> {
  let latest: string | undefined;
  try {
    latest = await fetchLatestPackageVersion(packageName, UPGRADE_REGISTRY_TIMEOUT_MS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(
      `Could not reach npm registry to resolve latest ${packageName} version (${reason}). ` +
        `Retry, or pass --version <version> to upgrade to a specific version.`,
    );
  }
  if (!latest) {
    fail(
      `Could not resolve latest ${packageName} version from npm. ` +
        `Retry, or pass --version <version> to upgrade to a specific version.`,
    );
  }
  return latest;
}
