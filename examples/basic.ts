/**
 * Basic example: using the runner programmatically.
 *
 * This runs a single agent turn and logs streamed runner events.
 */

import { TurnRunner, type TurnRunnerConfig } from "../src/index.js";

async function main() {
  const config: TurnRunnerConfig = {
    model: "opus-4.7",
    cwd: process.cwd(),
  };

  const runner = new TurnRunner(config);
  runner.subscribe((event) => {
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  await runner.start({ type: "start", mode: "agent" });
  const terminal = await runner.turn({
    type: "prompt",
    message:
      "Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint",
    behavior: "follow_up",
  });

  console.log("\n--- Session Summary ---");
  console.log(`Status: ${terminal.state.status}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
  console.log(terminal.state.stateMachine ? "State machine session" : "Agent session");
}

main().catch(console.error);
