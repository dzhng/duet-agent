#!/usr/bin/env node

/**
 * duet-agent CLI
 *
 * Usage:
 *   duet-agent "build a todo app in React"
 *   duet-agent --model claude-opus-4-7 "refactor auth system"
 *   echo "fix the bug in server.ts" | duet-agent
 */

import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { SessionManager } from "./session/session-manager.js";
import type { TurnRunnerConfig } from "./types/config.js";
import type { TurnStep, TurnTerminalEvent } from "./types/protocol.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let modelName = "anthropic:claude-opus-4-7";
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

  if (!prompt && !resumeSessionId && !interactive) {
    console.error("Usage: duet-agent <prompt>");
    console.error('  e.g., duet-agent "build a todo app"');
    process.exit(1);
  }

  if (modelName.indexOf(":") <= 0) {
    throw new Error("Models must use provider:modelId syntax");
  }

  dotenv.config({ path: join(workDir, ".env"), quiet: true });

  // Build config
  const config: TurnRunnerConfig = {
    model: modelName,
    cwd: workDir,
    ...(systemInstructions ? { systemInstructions } : {}),
    ...(systemPromptFiles ? { systemPromptFiles } : {}),
  };

  const manager = new SessionManager(config);
  let streamedTextThisTurn = false;
  manager.subscribe(({ event }) => {
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.type === "step") {
      if (event.step.type === "text") {
        streamedTextThisTurn = true;
      }
      handleStep(event.step);
    }
  });

  try {
    const session = resumeSessionId
      ? manager.resume(resumeSessionId)
      : manager.create({ mode: config.mode, prompt });
    let terminal: TurnTerminalEvent | undefined;
    let started = Boolean(prompt || resumeSessionId);
    if (prompt && resumeSessionId) {
      streamedTextThisTurn = false;
      await session.prompt({ message: prompt });
      terminal = await session.waitForTerminal();
      handleTerminal(terminal, {
        suppressHumanOutput: jsonOutput,
        suppressResult: streamedTextThisTurn,
      });
    } else if (prompt && !resumeSessionId) {
      terminal = await session.waitForTerminal();
      handleTerminal(terminal, {
        suppressHumanOutput: jsonOutput,
        suppressResult: streamedTextThisTurn,
      });
    }

    if (interactive) {
      process.stderr.write(`\nSession: ${session.id}\n`);
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (true) {
          const prompt = (await readline.question("> ")).trim();
          if (!prompt || prompt === "/exit" || prompt === "/quit") break;
          streamedTextThisTurn = false;
          if (started) {
            await session.prompt({ message: prompt });
          } else {
            await session.start({ prompt, mode: config.mode });
            started = true;
          }
          terminal = await session.waitForTerminal();
          handleTerminal(terminal, {
            suppressHumanOutput: jsonOutput,
            suppressResult: streamedTextThisTurn,
          });
        }
      } finally {
        readline.close();
      }
    }

    process.stderr.write(
      `Resume: ${resumeCommand(session.id, {
        modelName,
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
}

function handleStep(step: TurnStep): void {
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
  const input = step.input === undefined ? "" : `\n${JSON.stringify(step.input, null, 2)}`;
  return `\n[tool ${step.toolName}${status}]${input}\n[/tool]\n`;
}

function fail(message: string): never {
  console.error(`Fatal: ${message}`);
  process.exit(1);
}

function resumeCommand(
  sessionId: string,
  input: {
    modelName: string;
    workDir: string;
    systemInstructions?: string;
    systemPromptFiles?: string[];
  },
): string {
  const command = [
    "duet-agent",
    "--resume",
    shellQuote(sessionId),
    "--model",
    shellQuote(input.modelName),
    "--workdir",
    shellQuote(input.workDir),
  ];
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp() {
  console.log(`
duet-agent — An opinionated full-stack agent runner

USAGE
  duet-agent [options] [prompt]
  echo "prompt" | duet-agent

OPTIONS
  -m, --model <name>       TurnRunner model (default: anthropic:claude-opus-4-7)
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --system-prompt <text>   Additional system instructions for the runner
  --system-prompt-file <path>
                            Load a file into the system prompt; repeatable
  --no-system-prompt-files Disable default AGENTS.md system prompt loading
  --json                    Print streamed events as JSON lines
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet-agent keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation.

MODELS
  Use provider:modelId syntax, e.g. anthropic:claude-opus-4-7

EXAMPLES
  duet-agent "build a REST API with Express and TypeScript"
  duet-agent -m openai:gpt-5.5 "analyze the performance of our test suite"
  duet-agent -m vercel-ai-gateway:anthropic/claude-opus-4.7 "refactor the auth module"
  duet-agent --system-prompt "Prefer concise answers." "review this repo"
  duet-agent --system-prompt-file TEAM.md "review this repo"
  duet-agent --workdir ./my-project "refactor the auth module"
  duet-agent --resume session_abc123 --workdir ./my-project
`);
}

main();
