/**
 * Basic example: using duet-agent programmatically.
 *
 * This shows the core API — how all the pieces fit together.
 */

import { getModel } from "@mariozechner/pi-ai";
import { Orchestrator, type DuetAgentConfig } from "duet-agent";

async function main() {
  const config: DuetAgentConfig = {
    harnessModel: getModel("anthropic", "claude-opus-4-6"),
    cwd: process.cwd(),
  };

  const orchestrator = new Orchestrator(config);
  const state = await orchestrator.run(
    "Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint",
  );

  console.log("\n--- Run Summary ---");
  console.log(state.stateMachine ? "State machine run" : "Agent run");
}

main().catch(console.error);
