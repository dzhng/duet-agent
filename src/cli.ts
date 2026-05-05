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
import { SessionManager } from "./session/session.js";
import type { TurnRunnerConfig } from "./types/config.js";
import type { TurnTerminalEvent } from "./types/protocol.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let modelName = "anthropic:claude-opus-4-6";
  let workDir = process.cwd();
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        modelName = args[++i];
        break;
      case "--workdir":
      case "-w":
        workDir = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        goalParts.push(args[i]);
    }
  }

  let goal = goalParts.join(" ");

  // Read from stdin if no goal provided
  if (!goal && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    goal = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!goal) {
    console.error("Usage: duet-agent <goal>");
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
    const session = manager.create({ mode: config.mode, prompt: goal });
    let terminal = await session.waitForTerminal();
    handleTerminal(terminal);

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

    process.exit(0);
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
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
}

function printHelp() {
  console.log(`
duet-agent — An opinionated full-stack agent runner

USAGE
  duet-agent [options] <goal>
  echo "goal" | duet-agent

OPTIONS
  -m, --model <name>       TurnRunner model (default: anthropic:claude-opus-4-6)
  -w, --workdir <path>     Working directory (default: cwd)
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
`);
}

main();
