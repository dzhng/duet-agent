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
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type TextContent } from "@mariozechner/pi-ai";
import dotenv from "dotenv";
import packageJson from "../package.json" with { type: "json" };
import { shimDuetApiKeyToAiGateway } from "./duet-gateway/index.js";
import { formatCompactJson } from "./lib/compact-json.js";
import {
  describeModelResolution,
  resolveCliMemoryModel,
  resolveCliModel,
} from "./model-resolution/index.js";
import { SessionManager } from "./session/session-manager.js";
import { discoverInstalledSkills, resolveSkillScope } from "./turn-runner/skills.js";
import { runTui } from "./tui/app.js";
import type { TurnRunnerConfig } from "./types/config.js";
import type { TurnStep, TurnTerminalEvent, TurnTokenUsage } from "./types/protocol.js";

const VERSION_CHECK_TIMEOUT_MS = 1_500;
const DEFAULT_RESUME_HISTORY_LINES = 40;
const PACKAGE_MANAGERS = ["npm", "bun", "pnpm", "yarn"] as const;

type PackageManager = (typeof PACKAGE_MANAGERS)[number];

type PackageManagerDetectionContext = {
  userAgent?: string;
  runtimeExecutable?: string;
  cliFilePath?: string;
  scriptPath?: string;
};

const PACKAGE_METADATA = {
  name: packageJson.name,
  version: packageJson.version,
} satisfies PackageMetadata;

interface PackageMetadata {
  name: string;
  version: string;
}

async function main() {
  // Bridge DUET_API_KEY → AI_GATEWAY_API_KEY so the duet-gateway provider
  // resolves auth through pi-ai's vercel-ai-gateway path. Idempotent — caller's
  // explicit AI_GATEWAY_API_KEY wins.
  shimDuetApiKeyToAiGateway();

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
  if (args[0] === "skills") {
    try {
      runSkillsCommand(args.slice(1));
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
  let resumeHistoryLines = DEFAULT_RESUME_HISTORY_LINES;
  let resumeHistoryLinesExplicit = false;
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
      case "--resume-history-lines":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        try {
          resumeHistoryLines = parseResumeHistoryLines(args[++i]!, args[i - 1]!);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        resumeHistoryLinesExplicit = true;
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
        console.log(PACKAGE_METADATA.version);
        process.exit(0);
      }
      case "--help":
      case "-h":
        printHelp(PACKAGE_METADATA.name);
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
  const memoryModelResolution = resolveCliMemoryModel(memoryModelName, dotenvKeys);
  memoryModelName = memoryModelResolution.modelName;

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
    process.stderr.write(`Memory model: ${memoryModelName}\n`);
    process.stderr.write(`Memory source: ${describeModelResolution(memoryModelResolution)}\n`);
  }

  const manager = new SessionManager(config);
  // Best-effort state flush on signal-driven shutdown so Ctrl+C / SIGTERM
  // preserves mid-turn progress (in-flight agent messages, queued follow-ups,
  // todos written but not yet committed via terminal).
  let signalFlushed = false;
  const flushAndExit = (signal: NodeJS.Signals) => {
    if (signalFlushed) return;
    signalFlushed = true;
    void manager
      .flush()
      .catch((err) => console.error(`Flush during ${signal} failed:`, err))
      .finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
  };
  process.once("SIGINT", () => flushAndExit("SIGINT"));
  process.once("SIGTERM", () => flushAndExit("SIGTERM"));
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
          ...(config.mode ? { mode: config.mode } : {}),
          // Defer the prompt for TUI sessions so the user sees the prompt
          // streamed inside the UI rather than during the pre-TUI phase.
          ...(useTui || !prompt ? {} : { prompt }),
        });
    let terminal: TurnTerminalEvent | undefined;
    let initialTuiPrompt: string | undefined;
    let resumedHistory: import("@mariozechner/pi-agent-core").AgentMessage[] | undefined;

    if (resumeSessionId) {
      // Setup loads persisted state.json and hands it to the runner;
      // manager.create() already dispatched setup for fresh sessions.
      await session.start();
      if (!session.getState()) {
        throw new Error(`Unknown session: ${resumeSessionId}`);
      }
      resumedHistory = session.getState()?.agent.messages;
    }

    if (prompt && resumeSessionId) {
      streamedTextThisTurn = false;
      if (useTui) {
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
        initialTuiPrompt = prompt;
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
        ...(initialTuiPrompt ? { initialPrompt: initialTuiPrompt } : {}),
        ...(resumedHistory ? { history: resumedHistory } : {}),
        resumeHistoryLines,
        modelName,
        modelSource: describeModelResolution(modelResolution),
        memoryModelName,
        memoryModelSource: describeModelResolution(memoryModelResolution),
        workDir,
        sessionId: session.id,
        packageVersion: PACKAGE_METADATA.version,
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
        ...(resumeHistoryLinesExplicit ? { resumeHistoryLines } : {}),
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

export function parseResumeHistoryLines(
  value: string,
  optionName = "--resume-history-lines",
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return Number(value);
}

async function getNewVersionNotice(): Promise<string | undefined> {
  try {
    const latestVersion = await fetchLatestPackageVersion(PACKAGE_METADATA.name);
    if (!latestVersion) return undefined;
    if (compareSemverVersions(latestVersion, PACKAGE_METADATA.version) <= 0) return undefined;

    return formatNewVersionNotice(PACKAGE_METADATA.name, PACKAGE_METADATA.version, latestVersion);
  } catch {
    // Version checks should never block CLI startup or hide the real command output.
    return undefined;
  }
}

export function formatNewVersionNotice(
  packageName: string,
  currentVersion: string,
  latestVersion: string,
): string {
  return `Update available: ${packageName} ${currentVersion} -> ${latestVersion}. Run: duet upgrade`;
}

async function fetchLatestPackageVersion(packageName: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const metadataUrl = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
    const response = await fetch(metadataUrl, { signal: controller.signal });
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
  const packageName = PACKAGE_METADATA.name;

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
        printUpgradeHelp(packageName);
        return;
      default:
        fail(`Unknown upgrade option: ${args[i]}`);
    }
  }

  const command = globalUpgradeCommand(packageManager, packageName);
  const commandText = command.map(shellQuote).join(" ");
  if (dryRun) {
    console.log(commandText);
    return;
  }

  console.error(`Upgrading ${packageName} with ${packageManager}...`);
  await runCommand(command[0]!, command.slice(1));
}

function runSkillsCommand(args: string[]): void {
  let workDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workdir":
      case "-w":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workDir = args[++i]!;
        break;
      case "--help":
      case "-h":
        printSkillsHelp();
        return;
      default:
        fail(`Unknown skills option: ${args[i]}`);
    }
  }

  const { skills, collisions } = discoverInstalledSkills(workDir);
  const output = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: skill.baseDir,
    scope: resolveSkillScope(skill, workDir),
  }));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  for (const collision of collisions) {
    process.stderr.write(
      `[skill collision] "${collision.name}": kept ${collision.winnerPath}, ignored ${collision.loserPath}\n`,
    );
  }
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

function globalUpgradeCommand(packageManager: PackageManager, packageName: string): string[] {
  const packageSpec = `${packageName}@latest`;
  if (packageManager === "bun") return ["bun", "add", "--global", packageSpec];
  if (packageManager === "pnpm") return ["pnpm", "add", "--global", packageSpec];
  if (packageManager === "yarn") return ["yarn", "global", "add", packageSpec];
  return ["npm", "install", "--global", packageSpec];
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
    resumeHistoryLines?: number;
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
  if (input.resumeHistoryLines !== undefined) {
    command.push("--resume-history-lines", String(input.resumeHistoryLines));
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

function printHelp(packageName: string) {
  console.log(`
duet — An opinionated full-stack agent runner

USAGE
  duet [options] [prompt]
  duet skills [--workdir <path>]
  duet upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | duet

COMMANDS
  skills                   List installed skills as JSON (name, description, path, scope)
  upgrade                  Upgrade the global ${packageName} installation

OPTIONS
  -m, --model <name>       TurnRunner model override
  --memory-model <name>    Observational memory model (default inferred from provider env)
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --resume-history-lines <n>
                            Display up to n prior-session lines in the TUI (default: ${DEFAULT_RESUME_HISTORY_LINES})
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
  DUET_API_KEY, AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, or
  OPENAI_API_KEY after loading <workdir>/.env.

  duet-gateway: routes through the Duet gateway proxy
  (https://duet.so/api/v1/ai-gateway by default; override via
  DUET_GATEWAY_BASE_URL). It mirrors vercel-ai-gateway's model
  catalog and authenticates with DUET_API_KEY.

EXAMPLES
  duet "build a REST API with Express and TypeScript"
  duet -m openai:gpt-5.5 "analyze the performance of our test suite"
  duet --memory-model anthropic:claude-sonnet-4-6 "summarize this repo"
  duet -m vercel-ai-gateway:anthropic/claude-opus-4.7 "refactor the auth module"
  duet -m duet-gateway:anthropic/claude-opus-4.7 "review this repo"
  duet --system-prompt "Prefer concise answers." "review this repo"
  duet --system-prompt-file TEAM.md "review this repo"
  duet --workdir ./my-project "refactor the auth module"
  duet --resume session_abc123 --workdir ./my-project
  duet upgrade
`);
}

function printSkillsHelp() {
  console.log(`
duet skills — List installed skills as JSON

USAGE
  duet skills [--workdir <path>]

OPTIONS
  -w, --workdir <path>     Working directory for project-local skills (default: cwd)
  -h, --help               Show this help

OUTPUT
  Prints a JSON array of installed skills. Each entry has:
    name         Skill name
    description  Skill description (from frontmatter, raw — no shell expansion)
    path         Absolute path to the skill directory
    scope        "user", "project", or "temporary"
`);
}

function printUpgradeHelp(packageName: string) {
  console.log(`
duet upgrade — Upgrade the global ${packageName} installation

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
