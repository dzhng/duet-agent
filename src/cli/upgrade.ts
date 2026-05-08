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
export async function runUpgradeCommand(args: string[], packageName: string): Promise<void> {
  let packageManager: PackageManager = detectPackageManager();
  let dryRun = false;
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

  targetVersion ??= await fetchLatestPackageVersion(packageName);
  if (!targetVersion) {
    fail(`Could not resolve latest ${packageName} version from npm`);
  }
  const command = globalUpgradeCommand(packageManager, packageName, targetVersion);
  const commandText = command.map(shellQuote).join(" ");
  if (dryRun) {
    console.log(commandText);
    return;
  }

  console.error(`Upgrading ${packageName} to ${targetVersion} with ${packageManager}...`);
  await runCommand(command[0]!, command.slice(1));
}
