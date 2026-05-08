import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { printEnvHelp } from "./help.js";
import {
  defaultDuetEnvFilePath,
  fail,
  fileExists,
  mergeEnvEntries,
  resolveUserPath,
  SUPPORTED_API_KEYS,
} from "./shared.js";

export interface EnvCommandIO {
  cwd?: string;
  /** Override interactivity detection so tests can drive the paste flow. */
  interactive?: boolean;
  /** Inject a stand-in for the readline-backed key prompt. */
  promptForApiKeys?: () => Promise<Map<string, string>>;
  /** Inject a stand-in for the help-text printer. */
  printHelp?: () => void;
}

/**
 * Run `duet env`.
 *
 * Two modes share a target env file: `--import` copies provider keys from a
 * source env file (cwd .env by default), and `--keys` prompts the user for
 * each supported provider key. Without either flag we just print help.
 */
export async function runEnvCommand(args: string[], io: EnvCommandIO = {}): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  let envFilePath: string | undefined;
  let importEnvFilePath: string | undefined;
  let pasteKeys = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--env-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        envFilePath = args[++i]!;
        break;
      case "--import":
      case "-i":
        importEnvFilePath = args[i + 1]?.startsWith("-") ? "" : (args[++i] ?? "");
        break;
      case "--keys":
        pasteKeys = true;
        break;
      case "--help":
      case "-h":
        printEnvHelp();
        return;
      default:
        fail(`Unknown env option: ${args[i]}`);
    }
  }

  const targetEnvFile = envFilePath ? resolveUserPath(envFilePath, cwd) : defaultDuetEnvFilePath();
  const sourceEnvFile =
    importEnvFilePath === undefined
      ? undefined
      : importEnvFilePath
        ? resolveUserPath(importEnvFilePath, cwd)
        : join(cwd, ".env");
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);

  if (sourceEnvFile === undefined && !pasteKeys) {
    (io.printHelp ?? printEnvHelp)();
    return;
  }

  if (sourceEnvFile !== undefined) {
    if (!(await fileExists(sourceEnvFile))) {
      fail(`No .env file found at ${sourceEnvFile}`);
    }
    await importEnvFile(sourceEnvFile, targetEnvFile);
    console.error(`Imported ${sourceEnvFile} into ${targetEnvFile}`);
  }

  if (pasteKeys) {
    if (!interactive) {
      fail("duet env --keys requires an interactive terminal");
    }
    const entries = await (io.promptForApiKeys ?? promptForApiKeys)();
    if (entries.size === 0) {
      console.error("No API keys entered.");
      return;
    }
    await mergeEnvEntries(targetEnvFile, entries);
    console.error(`Saved API keys to ${targetEnvFile}`);
  }
}

/**
 * Copy a source env file's contents into the target env file. When the
 * target already exists we merge keys (source wins) instead of overwriting,
 * so existing local settings stay intact.
 */
async function importEnvFile(source: string, target: string): Promise<void> {
  if (resolve(source) === resolve(target)) {
    console.error(`${target} is already the shared env file.`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (!(await fileExists(target))) {
    await copyFile(source, target);
    return;
  }
  const parsed = dotenv.parse(await readFile(source));
  await mergeEnvEntries(target, new Map(Object.entries(parsed)));
}

/**
 * Prompt the user for each supported provider key on stderr; blank input
 * skips that key. We use stderr so piping `duet env --keys` does not pollute
 * stdout with prompt text.
 */
async function promptForApiKeys(): Promise<Map<string, string>> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const entries = new Map<string, string>();
    console.error("Paste API keys for any providers you want to use. Leave blank to skip.");
    for (const key of SUPPORTED_API_KEYS) {
      const value = (await rl.question(`${key}: `)).trim();
      if (value) entries.set(key, value);
    }
    return entries;
  } finally {
    rl.close();
  }
}
