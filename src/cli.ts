#!/usr/bin/env bun

/**
 * duet CLI entry point.
 *
 * Usage:
 *   duet "build a todo app in React"
 *   duet --model opus-4.7 "refactor auth system"
 *   echo "fix the bug in server.ts" | duet
 *
 * The actual command implementations live under `src/cli/`. This file is the
 * subcommand dispatcher and the public re-export surface for tests and
 * callers that historically imported helpers from `src/cli.ts`.
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { runConfigCommand } from "./cli/config.js";
import { runEnvCommand } from "./cli/env.js";
import { runLoginCommand } from "./cli/login.js";
import { runMemoryCommand } from "./cli/memory.js";
import { runModelCommand } from "./cli/model.js";
import { runRpcCommand } from "./cli/rpc.js";
import { runRouteCommand } from "./cli/route.js";
import { runRunCommand } from "./cli/run.js";
import { runSendFeedbackCommand } from "./cli/send-feedback.js";
import { runSkillsCommand } from "./cli/skills.js";
import { runTrainCommand } from "./cli/train.js";
import { runUpgradeCommand } from "./cli/upgrade.js";

// ---- public re-exports ----------------------------------------------------
// External tests and callers historically import these helpers from
// `src/cli.ts`. The implementations now live alongside their commands.

export type { CliTurnConfigInput, CliTurnConfigResolution, PackageMetadata } from "./cli/run.js";
export { buildCliTurnConfig, runRunCommand, shouldUseTui } from "./cli/run.js";
export { runRpcCommand } from "./cli/rpc.js";
export { runEnvCommand } from "./cli/env.js";
export type { EnvCommandIO } from "./cli/env.js";
export { runLoginCommand } from "./cli/login.js";
export type { LoginCommandIO } from "./cli/login.js";
export { runSkillsCommand } from "./cli/skills.js";
export { runUpgradeCommand } from "./cli/upgrade.js";
export { runMemoryCommand } from "./cli/memory.js";
export { runModelCommand } from "./cli/model.js";
export { runRouteCommand } from "./cli/route.js";
export { runConfigCommand } from "./cli/config.js";
export { runMemoryAddCommand } from "./cli/memory-add.js";
export { runMemoryRecallCommand } from "./cli/memory-recall.js";
export { runMemoryReflectCommand } from "./cli/memory-reflect.js";
export { runTrainCommand } from "./cli/train.js";
export { runSendFeedbackCommand } from "./cli/send-feedback.js";
export type { SendFeedbackCommandIO } from "./cli/send-feedback.js";
export {
  cliEnvFilePaths,
  defaultDuetEnvFilePath,
  expandHomeDir,
  fileExists,
  formatEnvEntries,
  loadCliEnvFiles,
  parseResumeHistoryMessages,
  resolveUserPath,
  shellQuote,
} from "./cli/shared.js";
export { detectPackageManagerFromContext, globalUpgradeCommand } from "./cli/package-manager.js";
export type { PackageManager, PackageManagerDetectionContext } from "./cli/package-manager.js";
export { compareSemverVersions, fetchLatestPackageVersion } from "./cli/version-check.js";
export { resumeCommand } from "./cli/resume-hint.js";
export type { ResumeCommandInput } from "./cli/resume-hint.js";

const PACKAGE_METADATA = {
  name: packageJson.name,
  version: packageJson.version,
} as const;

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  try {
    if (subcommand === "upgrade") {
      await runUpgradeCommand(args.slice(1), PACKAGE_METADATA.name);
      return;
    }
    if (subcommand === "skills") {
      runSkillsCommand(args.slice(1));
      return;
    }
    if (subcommand === "env") {
      await runEnvCommand(args.slice(1));
      return;
    }
    if (subcommand === "login") {
      await runLoginCommand(args.slice(1));
      return;
    }
    if (subcommand === "memory" || subcommand === "memories") {
      await runMemoryCommand(args.slice(1));
      return;
    }
    if (subcommand === "model") {
      await runModelCommand(args.slice(1));
      return;
    }
    if (subcommand === "route") {
      await runRouteCommand(args.slice(1));
      return;
    }
    if (subcommand === "config") {
      await runConfigCommand(args.slice(1));
      return;
    }
    if (subcommand === "train") {
      await runTrainCommand(args.slice(1));
      return;
    }
    if (subcommand === "send-feedback") {
      await runSendFeedbackCommand(args.slice(1));
      return;
    }

    // `--rpc` is a top-level routing flag rather than a subcommand because it
    // shares all model/workdir/env flags with the default run command; the
    // difference is only the I/O surface (stdin commands, stdout events).
    if (args.includes("--rpc")) {
      await runRpcCommand(args, PACKAGE_METADATA);
      return;
    }

    await runRunCommand(args, PACKAGE_METADATA);
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  }
}

/** True only when the dispatcher file itself, rather than cli-entry or a test, was invoked. */
export function isDirectCliInvocation(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  const moduleName = basename(fileURLToPath(moduleUrl));
  return ["cli.ts", "cli.js"].includes(moduleName) && basename(invokedPath) === moduleName;
}

// Bun's single-file compiler gives dynamically imported modules the executable's
// URL. The explicit filename check keeps cli-entry as the sole compiled owner.
if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  void runCli();
}
