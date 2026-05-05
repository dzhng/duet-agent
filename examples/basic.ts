/**
 * Basic example: using the runner programmatically.
 *
 * This runs a single agent turn and logs streamed runner events.
 */

import { TurnRunner, type TurnRunnerConfig } from "../src/index.js";

async function main() {
  const config: TurnRunnerConfig = {
    model: "vercel-ai-gateway:anthropic/claude-opus-4.6",
    cwd: process.cwd(),
  };

  const runner = new TurnRunner(config);
  runner.subscribe((event) => {
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  const terminal = await runner.turn({
    type: "start",
    mode: "agent",
    prompt: "Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint",
  });

  console.log("\n--- Session Summary ---");
  console.log(`Status: ${terminal.session.status}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
  console.log(terminal.session.stateMachine ? "State machine session" : "Agent session");
}

main().catch(console.error);
