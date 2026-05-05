#!/usr/bin/env node

/**
 * duet-agent CLI
 *
 * Usage:
 *   duet-agent "build a todo app in React"
 *   duet-agent --model claude-opus-4-6 "refactor auth system"
 *   echo "fix the bug in server.ts" | duet-agent
 */

import { createInterface } from "node:readline/promises";
import { SessionManager } from "./session/session-manager.js";
import type { TurnRunnerConfig } from "./types/config.js";
import type { TurnTerminalEvent } from "./types/protocol.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let modelName = "anthropic:claude-opus-4-6";
  let workDir = process.cwd();
  let resumeSessionId: string | undefined;
  const promptParts: string[] = [];

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
  if (!prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt && !resumeSessionId) {
    console.error("Usage: duet-agent <prompt>");
    console.error('  e.g., duet-agent "build a todo app"');
    process.exit(1);
  }

  if (modelName.indexOf(":") <= 0) {
    throw new Error("Models must use provider:modelId syntax");
  }

  // Build config
  const config: TurnRunnerConfig = {
    model: modelName,
    cwd: workDir,
  };

  const manager = new SessionManager(config);
  manager.subscribe(({ event }) => {
    if (event.type === "step") {
      process.stderr.write(`${JSON.stringify(event.step)}\n`);
    }
  });

  try {
    const session = resumeSessionId
      ? manager.resume(resumeSessionId)
      : manager.create({ mode: config.mode, prompt });
    let terminal: TurnTerminalEvent | undefined;
    if (prompt && resumeSessionId) {
      await session.prompt({ message: prompt });
      terminal = await session.waitForTerminal();
      handleTerminal(terminal);
    } else if (!resumeSessionId) {
      terminal = await session.waitForTerminal();
      handleTerminal(terminal);
    }

    if (process.stdin.isTTY) {
      process.stderr.write(`\nSession: ${session.id}\n`);
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (true) {
          const prompt = (await readline.question("> ")).trim();
          if (!prompt || prompt === "/exit" || prompt === "/quit") break;
          await session.prompt({ message: prompt });
          terminal = await session.waitForTerminal();
          handleTerminal(terminal);
        }
      } finally {
        readline.close();
      }
    }

    process.stderr.write(`Resume: ${resumeCommand(session.id, modelName, workDir)}\n`);
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await manager.dispose();
  }
}

function handleTerminal(terminal: TurnTerminalEvent): void {
  if (terminal.type === "complete" && terminal.error) {
    throw new Error(terminal.error);
  }
  if (terminal.type === "complete" && terminal.result) {
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

function fail(message: string): never {
  console.error(`Fatal: ${message}`);
  process.exit(1);
}

function resumeCommand(sessionId: string, modelName: string, workDir: string): string {
  return [
    "duet-agent",
    "--resume",
    shellQuote(sessionId),
    "--model",
    shellQuote(modelName),
    "--workdir",
    shellQuote(workDir),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp() {
  console.log(`
duet-agent — An opinionated full-stack agent runner

USAGE
  duet-agent [options] <prompt>
  echo "prompt" | duet-agent

OPTIONS
  -m, --model <name>       TurnRunner model (default: anthropic:claude-opus-4-6)
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet-agent keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation.

MODELS
  Use provider:modelId syntax, e.g. anthropic:claude-opus-4-6

EXAMPLES
  duet-agent "build a REST API with Express and TypeScript"
  duet-agent -m openai:gpt-5.4 "analyze the performance of our test suite"
  duet-agent -m vercel-ai-gateway:anthropic/claude-opus-4.6 "refactor the auth module"
  duet-agent --workdir ./my-project "refactor the auth module"
  duet-agent --resume session_abc123 --workdir ./my-project
`);
}

main();
