/**
 * Explicit state-machine example.
 *
 * This gives the runner a concrete state-machine definition with one agent
 * state and one terminal state, then asks the runner to run that process.
 */

import { TurnRunner, type TurnRunnerConfig, type StateMachineDefinition } from "../src/index.js";

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
  const config: TurnRunnerConfig = {
    model: "vercel-ai-gateway:anthropic/claude-opus-4.7",
    cwd: process.cwd(),
  };

  const runner = new TurnRunner(config);
  runner.subscribe((event) => {
    if (event.type === "state_machine") {
      console.log(`State: ${event.currentState}`);
    }
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  const initialState = await runner.start({ type: "start", mode: definition });
  const terminal = await runner.turn({
    type: "prompt",
    state: initialState,
    message: "Write a brief recommendation for using feature flags during risky launches.",
    behavior: "follow_up",
  });

  console.log("\n--- State Machine Summary ---");
  console.log(`Status: ${terminal.state.status}`);
  console.log(`Current state: ${terminal.state.stateMachine?.currentState ?? "none"}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
}

main().catch(console.error);
