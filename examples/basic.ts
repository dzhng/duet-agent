/**
 * Basic example: using duet-agent programmatically.
 *
 * This shows the core API — how all the pieces fit together.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
  Orchestrator,
  MemoryStore,
  LocalSandbox,
  StdioComm,
  PatternGuardrail,
  type DuetAgentConfig,
} from "duet-agent";

async function main() {
  const config: DuetAgentConfig = {
    // Smartest model for the orchestrator — it's doing the hard thinking
    orchestratorModel: getModel("anthropic", "claude-opus-4-6"),

    // Cheaper/faster model for sub-agents — they execute, not plan
    defaultSubAgentModel: getModel("anthropic", "claude-sonnet-4-6"),

    // Memory is event-emitting and in-memory by default. Persistence can subscribe to events.
    memory: new MemoryStore(),

    // Sandbox = bash. That's it. No MCP, no custom protocols.
    sandbox: new LocalSandbox(process.cwd()),

    // Comm layer is decoupled — swap this for voice, video, Slack, etc.
    comm: new StdioComm(),

    // Guardrails are optional but recommended
    guardrails: [new PatternGuardrail()],

    // Run up to 3 sub-agents concurrently
    maxConcurrency: 3,

    // Get notified on state transitions
    onTransition: (transition, state) => {
      console.error(`[${transition.fromPhase} → ${transition.toPhase}] ${transition.trigger}`);
    },

    // Get notified on interrupts
    onInterrupt: (interrupt) => {
      console.error(`[interrupt] ${interrupt.source.kind}: ${JSON.stringify(interrupt.source)}`);
    },
  };

  const orchestrator = new Orchestrator(config);
  const state = await orchestrator.run("Create a simple HTTP server in Node.js that serves a JSON API with a /health endpoint");

  console.log("\n--- Session Summary ---");
  console.log(`Goal: ${state.goal}`);
  console.log(`Phase: ${state.phase}`);
  console.log(`Tasks: ${state.tasks.length}`);
  for (const task of state.tasks) {
    console.log(`  [${task.status}] ${task.description}`);
  }
}

main().catch(console.error);
