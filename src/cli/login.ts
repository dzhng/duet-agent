import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";
import { loginWithBrowser } from "../lib/login.js";
import { syncDefaultSkills } from "../lib/sync-skills.js";
import { shimDuetApiKeyToAiGateway } from "../model-resolution/duet-gateway.js";
import { printLoginHelp } from "./help.js";
import { defaultDuetEnvFilePath, fail, mergeEnvEntries, resolveUserPath } from "./shared.js";

export interface LoginCommandIO {
  cwd?: string;
  envFilePath?: string;
}

/**
 * Run `duet login`.
 *
 * Opens the duet web app in a browser, waits for confirmation, persists the
 * returned `DUET_API_KEY` to the shared env file, then optionally syncs the
 * org's default skills bundle to `~/.duet/skills`.
 */
export async function runLoginCommand(args: string[], io: LoginCommandIO = {}): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  let envFilePathOverride: string | undefined = io.envFilePath;
  let noBrowser = false;
  let skipSkillSync = false;

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
      case "--help":
      case "-h":
        printLoginHelp();
        return;
      default:
        fail(`Unknown login option: ${args[i]}`);
    }
  }

  const targetEnvFile = envFilePathOverride
    ? resolveUserPath(envFilePathOverride, cwd)
    : defaultDuetEnvFilePath();

  const result = await loginWithBrowser({ noBrowser });

  await mergeEnvEntries(targetEnvFile, new Map([["DUET_API_KEY", result.apiKey]]));
  console.error(`Saved DUET_API_KEY for ${result.orgName} (${result.orgSlug}) to ${targetEnvFile}`);

  process.env.DUET_API_KEY = result.apiKey;
  shimDuetApiKeyToAiGateway();

  if (skipSkillSync) {
    console.error("Skipping default skill sync (--skip-skill-sync).");
    return;
  }

  console.error(`Checking default skills against ${resolveDuetAppBaseUrl()}...`);
  const syncResult = await syncDefaultSkills({ apiKey: result.apiKey });
  if (syncResult.status === "unchanged") {
    console.error("Default skills already up to date.");
  } else {
    console.error(`Synced default skills (${syncResult.count} total).`);
  }
}
