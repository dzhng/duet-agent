import { loginWithDeviceFlow } from "../lib/login.js";
import { printLoginHelp } from "./help.js";
import {
  defaultDuetEnvFilePath,
  fail,
  mergeEnvEntries,
  resolveUserPath,
  usageError,
} from "./shared.js";

export interface LoginCommandIO {
  cwd?: string;
  envFilePath?: string;
}

/**
 * Run `duet login`.
 *
 * Starts the Duet device flow for a workspace-scoped API key and persists the
 * returned `DUET_API_KEY` to the shared env file.
 */
export async function runLoginCommand(args: string[], io: LoginCommandIO = {}): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  let envFilePathOverride: string | undefined = io.envFilePath;
  let noBrowser = false;
  let workspaceSlug: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--env-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        envFilePathOverride = args[++i]!;
        break;
      case "--no-browser":
        noBrowser = true;
        break;
      case "--skip-skill-sync":
        // Deprecated no-op; tolerated so scripts that pass it do not break.
        break;
      case "--workspace":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workspaceSlug = args[++i]!;
        break;
      case "--help":
      case "-h":
        printLoginHelp();
        return;
      default:
        fail(`Unknown login option: ${args[i]}`);
    }
  }

  workspaceSlug = workspaceSlug?.trim() || process.env.DUET_WORKSPACE?.trim();
  if (!workspaceSlug) {
    usageError(
      "Missing required workspace. Pass `duet login --workspace <slug>` or set DUET_WORKSPACE; login creates one DUET_API_KEY scoped to one workspace.",
    );
  }

  const targetEnvFile = envFilePathOverride
    ? resolveUserPath(envFilePathOverride, cwd)
    : defaultDuetEnvFilePath();

  const result = await loginWithDeviceFlow({ noBrowser, workspaceSlug });

  await mergeEnvEntries(targetEnvFile, new Map([["DUET_API_KEY", result.apiKey]]));
  console.error(
    `Saved DUET_API_KEY for ${result.workspaceName} (${result.workspaceSlug}) to ${targetEnvFile}`,
  );
}
