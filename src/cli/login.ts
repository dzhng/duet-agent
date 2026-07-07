import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";
import { loginWithDeviceFlow } from "../lib/login.js";
import { syncDefaultSkills } from "../lib/sync-skills.js";
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
 * Starts the Duet device flow for a workspace-scoped API key, persists the
 * returned `DUET_API_KEY` to the shared env file, then optionally syncs the
 * workspace's default skills bundle to `~/.duet/skills`.
 */
export async function runLoginCommand(args: string[], io: LoginCommandIO = {}): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  let envFilePathOverride: string | undefined = io.envFilePath;
  let noBrowser = false;
  let skipSkillSync = false;
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
        skipSkillSync = true;
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

  process.env.DUET_API_KEY = result.apiKey;

  await fetch(`${resolveDuetAppBaseUrl()}/api/v1/analytics/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${result.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "cli_login" }),
  }).catch(() => {});

  if (skipSkillSync) {
    console.error("Skipping default skill sync (--skip-skill-sync).");
    return;
  }

  console.error(`Checking default skills against ${resolveDuetAppBaseUrl()}...`);
  const syncResult = await syncDefaultSkills({ apiKey: result.apiKey });
  if (syncResult.status === "unchanged") {
    console.error("Default skills already up to date.");
  } else if (syncResult.status === "not-found") {
    console.error("No default skills published.");
  } else {
    console.error(`Synced default skills (${syncResult.count} total).`);
  }
}
