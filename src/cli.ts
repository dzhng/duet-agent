#!/usr/bin/env bun

/**
 * duet CLI
 *
 * Usage:
 *   duet "build a todo app in React"
 *   duet --model claude-opus-4-7 "refactor auth system"
 *   echo "fix the bug in server.ts" | duet
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findEnvKeys, type TextContent } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import { formatCompactJson } from "./lib/compact-json.js";
import { SessionManager } from "./session/session-manager.js";
import { runTui } from "./tui/app.js";
import type { TurnRunnerConfig } from "./types/config.js";
import type { TurnStep, TurnTerminalEvent, TurnTokenUsage } from "./types/protocol.js";

const NPM_PACKAGE_NAME = "@dzhng/duet-agent";
const NPM_PACKAGE_METADATA_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME.replace(
  "/",
  "%2F",
)}`;
const VERSION_CHECK_TIMEOUT_MS = 1_500;
const PACKAGE_MANAGERS = ["npm", "bun", "pnpm", "yarn"] as const;

const INFERRED_ANTHROPIC_MODEL = "anthropic:claude-opus-4-7";
const INFERRED_AI_GATEWAY_MODEL = "vercel-ai-gateway:anthropic/claude-opus-4.7";
const INFERRED_OPENROUTER_MODEL = "openrouter:anthropic/claude-opus-4.7";
const INFERRED_OPENAI_MODEL = "openai:gpt-5.5";
const DEFAULT_CLI_MODEL = INFERRED_ANTHROPIC_MODEL;

type PackageManager = (typeof PACKAGE_MANAGERS)[number];

type PackageManagerDetectionContext = {
  userAgent?: string;
  runtimeExecutable?: string;
  cliFilePath?: string;
  scriptPath?: string;
};

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "upgrade") {
    try {
      await runUpgradeCommand(args.slice(1));
    } catch (err: any) {
      console.error(`Fatal: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Parse flags
  let modelName: string | undefined;
  let memoryModelName: string | undefined;
  let workDir = process.cwd();
  let resumeSessionId: string | undefined;
  let systemInstructions: string | undefined;
  let systemPromptFiles: string[] | undefined;
  let jsonOutput = false;
  const promptParts: string[] = [];
  const interactive = Boolean(process.stdin.isTTY ?? process.stdout.isTTY);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        modelName = args[++i];
        break;
      case "--memory-model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        memoryModelName = args[++i];
        break;
      case "--workdir":
      case "-w":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workDir = args[++i];
        break;
      case "--resume":
      case "-r":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        resumeSessionId = args[++i];
        break;
      case "--system-prompt":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemInstructions = args[++i];
        break;
      case "--system-prompt-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemPromptFiles = [...(systemPromptFiles ?? []), args[++i]];
        break;
      case "--no-system-prompt-files":
        systemPromptFiles = [];
        break;
      case "--json":
        jsonOutput = true;
        break;
      case "--version":
      case "-v": {
        const version = (await readInstalledPackageVersion()) ?? "unknown";
        console.log(version);
        process.exit(0);
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (args[i]?.startsWith("-")) {
          fail(`Unknown option: ${args[i]}`);
        }
        promptParts.push(args[i]);
    }
  }

  let prompt = promptParts.join(" ");

  // Read from stdin if no prompt is provided
  if (!prompt && !interactive) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt && jsonOutput && interactive) {
    prompt = await readInteractivePrompt();
  }

  if (!prompt && !resumeSessionId && !interactive) {
    console.error("Usage: duet <prompt>");
    console.error('  e.g., duet "build a todo app"');
    process.exit(1);
  }

  const dotenvResult = dotenv.config({ path: join(workDir, ".env"), quiet: true });
  const dotenvKeys = new Set<string>(Object.keys(dotenvResult.parsed ?? {}));

  const modelResolution = resolveCliModel(modelName, dotenvKeys);
  modelName = modelResolution.modelName;

  if (modelName && modelName.indexOf(":") <= 0) {
    throw new Error("Models must use provider:modelId syntax");
  }
  if (memoryModelName && memoryModelName.indexOf(":") <= 0) {
    throw new Error("Memory model must use provider:modelId syntax");
  }

  // Build config
  const config: TurnRunnerConfig = {
    ...(modelName ? { model: modelName } : {}),
    ...(memoryModelName ? { memoryModel: memoryModelName } : {}),
    cwd: workDir,
    ...(systemInstructions ? { systemInstructions } : {}),
    ...(systemPromptFiles ? { systemPromptFiles } : {}),
  };

  // The TUI owns rendering when active, so we suppress stdout step printing
  // there to avoid corrupting the alternate-screen UI.
  const useTui = interactive && !jsonOutput;

  const newVersionNotice = await getNewVersionNotice();
  if (!useTui) {
    if (newVersionNotice) process.stderr.write(`${newVersionNotice}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
    process.stderr.write(`Source: ${describeModelResolution(modelResolution)}\n`);
  }

  const manager = new SessionManager(config);
  let streamedTextThisTurn = false;
  let activeTextDelta = false;
  let activeTextDeltaNeedsNewline = false;
  let activeReasoningDelta = false;
  let activeReasoningDeltaNeedsNewline = false;
  const finishActiveDeltaStreams = () => {
    if (activeTextDelta) {
      if (activeTextDeltaNeedsNewline) process.stdout.write("\n");
      activeTextDelta = false;
      activeTextDeltaNeedsNewline = false;
    }
    if (activeReasoningDelta) {
      if (activeReasoningDeltaNeedsNewline) process.stderr.write("\n");
      process.stderr.write("[/reasoning]\n");
      activeReasoningDelta = false;
      activeReasoningDeltaNeedsNewline = false;
    }
  };
  manager.subscribe(({ event }) => {
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.type === "step" && !useTui) {
      if (event.step.type === "text_delta") {
        streamedTextThisTurn = true;
        activeTextDelta = true;
        activeTextDeltaNeedsNewline = !event.step.delta.endsWith("\n");
        process.stdout.write(event.step.delta);
      } else if (event.step.type === "reasoning_delta") {
        if (!activeReasoningDelta) process.stderr.write("\n[reasoning]\n");
        activeReasoningDelta = true;
        activeReasoningDeltaNeedsNewline = !event.step.delta.endsWith("\n");
        process.stderr.write(event.step.delta);
      } else if (event.step.type === "text") {
        streamedTextThisTurn = true;
        if (activeTextDelta) {
          finishActiveDeltaStreams();
        } else {
          handleStep(event.step);
        }
      } else if (event.step.type === "reasoning" && activeReasoningDelta) {
        finishActiveDeltaStreams();
      } else {
        handleStep(event.step);
      }
    } else if (
      event.type === "step" &&
      (event.step.type === "text" || event.step.type === "text_delta")
    ) {
      // Track streaming even when the TUI is rendering, so post-TUI fallback
      // result handling stays consistent.
      streamedTextThisTurn = true;
    } else if (!jsonOutput && !useTui && isTerminalEvent(event)) {
      finishActiveDeltaStreams();
    }
  });

  try {
    const session = resumeSessionId
      ? manager.resume(resumeSessionId)
      : manager.create({
          mode: config.mode,
          ...(useTui && prompt ? {} : { prompt }),
        });
    let terminal: TurnTerminalEvent | undefined;
    let started = Boolean(prompt || resumeSessionId);
    let initialTuiPrompt: string | undefined;
    let resumedHistory: import("@mariozechner/pi-agent-core").AgentMessage[] | undefined;

    if (resumeSessionId && useTui) {
      // Force-load the persisted state.json so the TUI can replay past
      // messages into its transcript before any new turn dispatches.
      await session.hydrate();
      if (!session.getState()) {
        throw new Error(`Unknown session: ${resumeSessionId}`);
      }
      resumedHistory = session.getState()?.agent.messages;
    }

    if (prompt && resumeSessionId) {
      // Resuming an existing session with a new prompt — run it before the TUI
      // takes over so any non-interactive output is preserved.
      streamedTextThisTurn = false;
      if (useTui) {
        // Defer to TUI: it will dispatch the prompt itself as a follow-up.
        initialTuiPrompt = prompt;
      } else {
        await session.prompt({ message: prompt });
        terminal = await session.waitForTerminal();
        handleTerminal(terminal, {
          suppressHumanOutput: jsonOutput,
          suppressResult: streamedTextThisTurn,
        });
      }
    } else if (prompt && !resumeSessionId) {
      if (useTui) {
        // The session was created with this prompt but not yet started; let the
        // TUI start it so the user sees streaming inside the UI.
        initialTuiPrompt = prompt;
        started = false;
      } else {
        terminal = await session.waitForTerminal();
        handleTerminal(terminal, {
          suppressHumanOutput: jsonOutput,
          suppressResult: streamedTextThisTurn,
        });
      }
    }

    if (useTui) {
      terminal = await runTui({
        session,
        started,
        ...(initialTuiPrompt ? { initialPrompt: initialTuiPrompt } : {}),
        ...(resumedHistory ? { history: resumedHistory } : {}),
        mode: config.mode,
        modelName,
        modelSource: describeModelResolution(modelResolution),
        ...(newVersionNotice ? { newVersionNotice } : {}),
      });
    }

    process.stderr.write(
      `Resume: ${resumeCommand(session.id, {
        modelName,
        memoryModelName,
        workDir,
        systemInstructions,
        systemPromptFiles,
      })}\n`,
    );
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await manager.dispose();
  }
}

function handleTerminal(
  terminal: TurnTerminalEvent,
  options: { suppressHumanOutput?: boolean; suppressResult?: boolean } = {},
): void {
  if (options.suppressHumanOutput) return;
  if (terminal.type === "complete" && terminal.error) {
    throw new Error(terminal.error);
  }
  if (terminal.type === "complete" && terminal.result && !options.suppressResult) {
    process.stdout.write(`${terminal.result}\n`);
  }
  if (terminal.type === "ask") {
    for (const question of terminal.questions) {
      process.stdout.write(`${question.question}\n`);
    }
  }
  if (terminal.type === "interrupted") {
    process.stderr.write("Interrupted.\n");
  }
  if (terminal.type === "sleep") {
    process.stderr.write(`Sleeping until ${new Date(terminal.wakeAt).toISOString()}.\n`);
  }
  if (terminal.usage) {
    process.stderr.write(`${formatUsage(terminal.usage)}\n`);
  }
}

function isTerminalEvent(event: { type: string }): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function formatUsage(usage: TurnTokenUsage): string {
  const parts = [`in=${usage.inputTokens}`, `out=${usage.outputTokens}`];
  if (usage.cachedInputTokens !== undefined) parts.push(`cached=${usage.cachedInputTokens}`);
  let line = `Tokens: ${parts.join(" ")}`;
  if (usage.costUsd !== undefined) line += ` \u00b7 Cost: $${usage.costUsd.toFixed(4)}`;
  return line;
}

function handleStep(step: TurnStep): void {
  if (step.type === "text_delta") {
    process.stdout.write(step.delta);
  }
  if (step.type === "reasoning_delta") {
    process.stderr.write(step.delta);
  }
  if (step.type === "text") {
    process.stdout.write(`${step.text}\n`);
  }
  if (step.type === "reasoning") {
    process.stderr.write(formatReasoning(step.text));
  }
  if (step.type === "tool_call") {
    process.stderr.write(formatToolCall(step));
  }
  if (step.type === "system") {
    process.stderr.write(`${step.message}\n`);
  }
}

function formatReasoning(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `\n[reasoning]\n${trimmed}\n[/reasoning]\n`;
}

function formatToolCall(step: Extract<TurnStep, { type: "tool_call" }>): string {
  const status = step.status ? ` ${step.status}` : "";
  const input = step.input === undefined ? "" : `\n${formatCompactJson(step.input)}`;
  let output = "";
  if (step.output && step.output.length > 0) {
    const text = step.output
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) {
      const label = step.status === "error" ? "output error" : "output";
      output = `\n[${label}]\n${text}\n[/output]\n`;
    }
  }
  return `\n[tool ${step.toolName}${status}]${input}${output}\n[/tool]\n`;
}

function fail(message: string): never {
  console.error(`Fatal: ${message}`);
  process.exit(1);
}

/**
 * Describes how the CLI arrived at a model selection. Used to render a
 * provenance hint at startup so users understand why their session is talking
 * to the model it picked.
 */
export interface ModelResolution {
  modelName: string;
  /** explicit: --model flag; inferred: provider env var present; default: built-in fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "ANTHROPIC_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from <workdir>/.env rather than the shell. */
  fromDotenv?: boolean;
}

const PROVIDER_INFERENCE: Array<{ provider: string; model: string }> = [
  { provider: "anthropic", model: INFERRED_ANTHROPIC_MODEL },
  { provider: "vercel-ai-gateway", model: INFERRED_AI_GATEWAY_MODEL },
  { provider: "openrouter", model: INFERRED_OPENROUTER_MODEL },
  { provider: "openai", model: INFERRED_OPENAI_MODEL },
];

export function inferDefaultModelName(): string | undefined {
  for (const entry of PROVIDER_INFERENCE) {
    if (findEnvKeys(entry.provider)) return entry.model;
  }
  return undefined;
}

export function resolveCliModelName(modelName: string | undefined): string {
  return resolveCliModel(modelName).modelName;
}

/**
 * Same selection logic as resolveCliModelName, but also reports the provenance
 * so callers can show "inferred from ANTHROPIC_API_KEY in .env" etc.
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string> = new Set(),
): ModelResolution {
  if (modelName) return { modelName, source: "explicit" };
  for (const entry of PROVIDER_INFERENCE) {
    const envVars = findEnvKeys(entry.provider);
    if (envVars && envVars.length > 0) {
      const envVar = envVars[0]!;
      return {
        modelName: entry.model,
        source: "inferred",
        envVar,
        fromDotenv: dotenvKeys.has(envVar),
      };
    }
  }
  return { modelName: DEFAULT_CLI_MODEL, source: "default" };
}

export function describeModelResolution(resolution: ModelResolution): string {
  if (resolution.source === "explicit") return "--model flag";
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "<workdir>/.env" : "shell environment";
    return `inferred from ${resolution.envVar} in ${where}`;
  }
  return "built-in default (no provider env vars set)";
}

async function getNewVersionNotice(): Promise<string | undefined> {
  try {
    const [currentVersion, latestVersion] = await Promise.all([
      readInstalledPackageVersion(),
      fetchLatestPackageVersion(),
    ]);
    if (!currentVersion || !latestVersion) return undefined;
    if (compareSemverVersions(latestVersion, currentVersion) <= 0) return undefined;

    return formatNewVersionNotice(currentVersion, latestVersion);
  } catch {
    // Version checks should never block CLI startup or hide the real command output.
    return undefined;
  }
}

export function formatNewVersionNotice(currentVersion: string, latestVersion: string): string {
  return `Update available: ${NPM_PACKAGE_NAME} ${currentVersion} -> ${latestVersion}. Run: duet upgrade`;
}

async function readInstalledPackageVersion(): Promise<string | undefined> {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const packagePaths = [
    join(cliDir, "..", "package.json"),
    join(cliDir, "..", "..", "package.json"),
  ];

  for (const packagePath of packagePaths) {
    try {
      const packageJson = JSON.parse(await readFile(packagePath, "utf-8")) as {
        version?: unknown;
      };
      if (typeof packageJson.version === "string") return packageJson.version;
    } catch {
      // Source builds and published builds place package.json at different depths.
    }
  }
  return undefined;
}

async function fetchLatestPackageVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(NPM_PACKAGE_METADATA_URL, { signal: controller.signal });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as {
      "dist-tags"?: { latest?: unknown };
    };
    const latest = metadata["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function compareSemverVersions(left: string, right: string): number {
  const leftParts = parseSemverVersion(left);
  const rightParts = parseSemverVersion(right);
  for (let i = 0; i < 3; i++) {
    const delta = leftParts.numbers[i]! - rightParts.numbers[i]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return leftParts.prerelease.localeCompare(rightParts.prerelease);
}

function parseSemverVersion(version: string): {
  numbers: [number, number, number];
  prerelease?: string;
} {
  const [main = "", prerelease] = version.replace(/^v/, "").split("-", 2);
  const [major = "0", minor = "0", patch = "0"] = main.split(".");
  return {
    numbers: [Number(major) || 0, Number(minor) || 0, Number(patch) || 0],
    ...(prerelease ? { prerelease } : {}),
  };
}

async function runUpgradeCommand(args: string[]): Promise<void> {
  let packageManager = detectPackageManager();
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manager":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        packageManager = parsePackageManager(args[++i]!);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printUpgradeHelp();
        return;
      default:
        fail(`Unknown upgrade option: ${args[i]}`);
    }
  }

  const command = globalUpgradeCommand(packageManager);
  const commandText = command.map(shellQuote).join(" ");
  if (dryRun) {
    console.log(commandText);
    return;
  }

  console.error(`Upgrading ${NPM_PACKAGE_NAME} with ${packageManager}...`);
  await runCommand(command[0]!, command.slice(1));
}

function parsePackageManager(value: string): PackageManager {
  if (PACKAGE_MANAGERS.includes(value as PackageManager)) return value as PackageManager;
  fail(`Unsupported package manager: ${value}`);
}

function detectPackageManager(): PackageManager {
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

function globalUpgradeCommand(packageManager: PackageManager): string[] {
  const packageName = `${NPM_PACKAGE_NAME}@latest`;
  if (packageManager === "bun") return ["bun", "add", "--global", packageName];
  if (packageManager === "pnpm") return ["pnpm", "add", "--global", packageName];
  if (packageManager === "yarn") return ["yarn", "global", "add", packageName];
  return ["npm", "install", "--global", packageName];
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: "inherit" });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode ?? 1;
  }
}

async function readInteractivePrompt(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    let prompt = "";
    while (!prompt) {
      prompt = (await rl.question("> ")).trim();
    }
    return prompt;
  } finally {
    rl.close();
  }
}

function resumeCommand(
  sessionId: string,
  input: {
    modelName?: string;
    memoryModelName?: string;
    workDir: string;
    systemInstructions?: string;
    systemPromptFiles?: string[];
  },
): string {
  const command = [
    detectInvocationPrefix(),
    "--resume",
    shellQuote(sessionId),
    "--workdir",
    shellQuote(input.workDir),
  ];
  if (input.modelName) {
    command.push("--model", shellQuote(input.modelName));
  }
  if (input.memoryModelName) {
    command.push("--memory-model", shellQuote(input.memoryModelName));
  }
  if (input.systemInstructions) {
    command.push("--system-prompt", shellQuote(input.systemInstructions));
  }
  if (input.systemPromptFiles) {
    if (input.systemPromptFiles.length === 0) {
      command.push("--no-system-prompt-files");
    } else {
      for (const fileName of input.systemPromptFiles) {
        command.push("--system-prompt-file", shellQuote(fileName));
      }
    }
  }
  return command.join(" ");
}

// Detect how this CLI was invoked so the resume hint copy-pastes back into
// the user's actual shell. `bun run cli` and `bun src/cli.ts` are common
// during local development; the published bin is `duet`.
function detectInvocationPrefix(): string {
  const scriptPath = process.argv[1] ?? "";
  const base = basename(scriptPath);
  if (process.env.npm_lifecycle_event === "cli") return "bun run cli";
  if (base === "cli.ts" || scriptPath.includes("/src/cli.ts")) return "bun src/cli.ts";
  return "duet";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp() {
  console.log(`
duet — An opinionated full-stack agent runner

USAGE
  duet [options] [prompt]
  duet upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | duet

COMMANDS
  upgrade                  Upgrade the global ${NPM_PACKAGE_NAME} installation

OPTIONS
  -m, --model <name>       TurnRunner model override
  --memory-model <name>    Observational memory model (default: anthropic:claude-sonnet-4-6)
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --system-prompt <text>   Additional system instructions for the runner
  --system-prompt-file <path>
                            Load a file into the system prompt; repeatable
  --no-system-prompt-files Disable default AGENTS.md system prompt loading
  --json                    Print streamed events as JSON lines
  -v, --version            Print the installed duet version and exit
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation.

MODELS
  Use provider:modelId syntax, e.g. anthropic:claude-opus-4-7.
  If omitted, duet infers a default from ANTHROPIC_API_KEY,
  AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY
  after loading <workdir>/.env.

EXAMPLES
  duet "build a REST API with Express and TypeScript"
  duet -m openai:gpt-5.5 "analyze the performance of our test suite"
  duet --memory-model anthropic:claude-sonnet-4-6 "summarize this repo"
  duet -m vercel-ai-gateway:anthropic/claude-opus-4.7 "refactor the auth module"
  duet --system-prompt "Prefer concise answers." "review this repo"
  duet --system-prompt-file TEAM.md "review this repo"
  duet --workdir ./my-project "refactor the auth module"
  duet --resume session_abc123 --workdir ./my-project
  duet upgrade
`);
}

function printUpgradeHelp() {
  console.log(`
duet upgrade — Upgrade the global ${NPM_PACKAGE_NAME} installation

USAGE
  duet upgrade [--manager npm|bun|pnpm|yarn]

OPTIONS
  --manager <name>         Package manager to use (default: detected, fallback: npm)
  --dry-run                Print the upgrade command without running it
  -h, --help               Show this help
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
