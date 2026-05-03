/**
 * Basic example: using duet-agent programmatically.
 *
 * This shows the core API — how all the pieces fit together.
 */

import { getModel } from "@mariozechner/pi-ai";
import { Orchestrator, type DuetAgentConfig } from "duet-agent";

async function main() {
  const config: DuetAgentConfig = {
    orchestratorModel: getModel("anthropic", "claude-opus-4-6"),
    cwd: process.cwd(),
  };

  const orchestrator = new Orchestrator(config);
  const state = await orchestrator.run(
    "Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint",
  );

  console.log("\n--- Run Summary ---");
  console.log(`Goal: ${state.goal}`);
  console.log(`Status: ${state.status}`);
  console.log(`Todos: ${state.todos.length}`);
  for (const todo of state.todos) {
    console.log(`  [${todo.status}] ${todo.content}`);
  }
}

main().catch(console.error);
