#!/usr/bin/env node

/**
 * duet-agent CLI
 *
 * Usage:
 *   duet-agent "build a todo app in React"
 *   duet-agent --model claude-opus-4-6 "refactor auth system"
 *   echo "fix the bug in server.ts" | duet-agent
 */

import { getModel, type Model } from "@mariozechner/pi-ai";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { LocalSandbox } from "./sandbox/local.js";
import { StdioComm } from "./comm/stdio.js";
import type { DuetAgentConfig } from "./core/types.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let orchestratorModelName = "claude-opus-4-6";
  let subAgentModelName = "claude-sonnet-4-6";
  let workDir = process.cwd();
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        orchestratorModelName = args[++i];
        break;
      case "--sub-model":
        subAgentModelName = args[++i];
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

  // Resolve models
  const orchestratorModel = resolveModel(orchestratorModelName);
  const subAgentModel = resolveModel(subAgentModelName);

  // Build config
  const config: DuetAgentConfig = {
    orchestratorModel,
    defaultSubAgentModel: subAgentModel,
    sandbox: new LocalSandbox(workDir),
    comm: new StdioComm(),
    maxConcurrency: 3,
    onTransition: (t, state) => {
      process.stderr.write(
        `[${new Date(t.timestamp).toISOString()}] ${t.fromPhase} → ${t.toPhase}: ${t.trigger}\n`,
      );
    },
  };

  const orchestrator = new Orchestrator(config);

  try {
    const state = await orchestrator.run(goal);
    const completed = state.tasks.filter((t) => t.status === "completed").length;
    const failed = state.tasks.filter((t) => t.status === "failed").length;
    process.stderr.write(`\nDone. ${completed} tasks completed, ${failed} failed.\n`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  }
}

function resolveModel(name: string): Model<any> {
  const providerSeparator = name.indexOf(":");
  if (providerSeparator > 0) {
    const provider = name.slice(0, providerSeparator);
    const modelId = name.slice(providerSeparator + 1);
    return getModel(provider as any, modelId as any);
  }

  // Anthropic models
  if (name.startsWith("claude-")) {
    return getModel("anthropic", name as any);
  }
  // OpenAI models
  if (name.startsWith("gpt-") || name.startsWith("o1") || name.startsWith("o3")) {
    return getModel("openai", name as any);
  }
  // Default: try anthropic
  return getModel("anthropic", name as any);
}

function printHelp() {
  console.log(`
duet-agent — An opinionated full-stack agent harness

USAGE
  duet-agent [options] <goal>
  echo "goal" | duet-agent

OPTIONS
  -m, --model <name>       Orchestrator model (default: claude-opus-4-6)
  --sub-model <name>       Sub-agent model (default: claude-sonnet-4-6)
  -w, --workdir <path>     Working directory (default: cwd)
  -h, --help               Show this help

MODELS
  Anthropic: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
  OpenAI: gpt-5.4, gpt-4o, o3-mini
  Provider syntax: vercel-ai-gateway:anthropic/claude-opus-4.6

EXAMPLES
  duet-agent "build a REST API with Express and TypeScript"
  duet-agent -m gpt-5.4 "analyze the performance of our test suite"
  duet-agent -m vercel-ai-gateway:anthropic/claude-opus-4.6 --sub-model vercel-ai-gateway:anthropic/claude-sonnet-4.6 "refactor the auth module"
  duet-agent --workdir ./my-project "refactor the auth module"
`);
}

main();
