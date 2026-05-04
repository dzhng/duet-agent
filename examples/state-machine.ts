/**
 * Explicit state-machine example.
 *
 * This gives the harness a concrete state-machine definition with one agent
 * state and one terminal state, then asks the harness to run that process.
 */

import { Harness, type HarnessConfig, type StateMachineDefinition } from "../src/index.js";

const definition: StateMachineDefinition = {
  name: "brief_writer",
  prompt:
    "Use this state machine when the user wants a short written brief, summary, or recommendation.",
  states: [
    {
      kind: "agent",
      name: "write_brief",
      when: "The user needs the brief written.",
      prompt:
        "Write a concise brief for the user's request. Keep it under 120 words and do not edit files.",
      contextScope: "state_machine",
    },
    {
      kind: "terminal",
      name: "brief_finished",
      status: "completed",
      reason: "The requested brief was written.",
    },
  ],
};

async function main() {
  const config: HarnessConfig = {
    harnessModel: "vercel-ai-gateway:anthropic/claude-opus-4.6",
    cwd: process.cwd(),
  };

  const harness = new Harness(config);
  harness.subscribe((event) => {
    if (event.type === "state_machine") {
      console.log(`State: ${event.currentState}`);
    }
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  const terminal = await harness.turn({
    type: "start",
    mode: definition,
    prompt: "Write a brief recommendation for using feature flags during risky launches.",
  });

  console.log("\n--- State Machine Summary ---");
  console.log(`Status: ${terminal.run.status}`);
  console.log(`Current state: ${terminal.run.stateMachine?.currentState ?? "none"}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
}

main().catch(console.error);
