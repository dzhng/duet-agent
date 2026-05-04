/**
 * Basic example: using the harness programmatically.
 *
 * This runs a single agent turn and logs streamed harness events.
 */

import { Harness, type HarnessConfig } from "../src/index.js";

async function main() {
  const config: HarnessConfig = {
    harnessModel: "vercel-ai-gateway:anthropic/claude-opus-4.6",
    cwd: process.cwd(),
  };

  const harness = new Harness(config);
  harness.subscribe((event) => {
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  const terminal = await harness.turn({
    type: "start",
    mode: "agent",
    prompt: "Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint",
  });

  console.log("\n--- Run Summary ---");
  console.log(`Status: ${terminal.run.status}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
  console.log(terminal.run.stateMachine ? "State machine run" : "Agent run");
}

main().catch(console.error);
