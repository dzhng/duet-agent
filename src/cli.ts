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

import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { runEnvCommand } from "./cli/env.js";
import { runLoginCommand } from "./cli/login.js";
import { runMemoryCommand } from "./cli/memory.js";
import { runRpcCommand } from "./cli/rpc.js";
import { runRunCommand } from "./cli/run.js";
import { runSendFeedbackCommand } from "./cli/send-feedback.js";
import { runSkillsCommand } from "./cli/skills.js";
import { runUpgradeCommand } from "./cli/upgrade.js";
import { shimDuetApiKeyToAiGateway } from "./model-resolution/duet-gateway.js";

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
export { runSendFeedbackCommand } from "./cli/send-feedback.js";
export type { SendFeedbackCommandIO } from "./cli/send-feedback.js";
export {
  cliEnvFilePaths,
  defaultDuetEnvFilePath,
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

async function main(): Promise<void> {
  // Bridge DUET_API_KEY → AI_GATEWAY_API_KEY so the duet-gateway provider
  // resolves auth through pi-ai's vercel-ai-gateway path. Idempotent — caller's
  // explicit AI_GATEWAY_API_KEY wins.
  shimDuetApiKeyToAiGateway();

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
