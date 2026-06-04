import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { TurnTerminalEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

// The orchestrating runner routes on this model; the per-state override points
// the sub-agent at a different one so the captured value is unambiguous.
const runnerModel = process.env.EVAL_MODEL ?? "sonnet-4.6";
const stateModel = runnerModel === "haiku-4.5" ? "sonnet-4.6" : "haiku-4.5";
const stateThinkingLevel = "high" as const;

// Captures the options every agent gets at creation time, tagging which calls
// are state-agent sub-agents (only those pass a prependSystemPrompt). The
// model/thinkingLevel fields are UI-only and never reach the tool schemas, so
// the only way to exercise them is to set them on the definition directly,
// exactly as the UI will.
class CapturingRunner extends TurnRunner {
  readonly stateAgentOptions: { model?: string; thinkingLevel?: string }[] = [];

  protected createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    if (input.prependSystemPrompt !== undefined) {
      this.stateAgentOptions.push({
        model: input.state.options?.model,
        thinkingLevel: input.state.options?.thinkingLevel,
      });
    }
    return super.createAgent(input, onControlResult);
  }
}

function buildDefinition(agentState: {
  model?: string;
  thinkingLevel?: typeof stateThinkingLevel;
}): StateMachineDefinition {
  return {
    name: "agent_model_eval",
    prompt: "Validate that an agent state's model/thinkingLevel scope the sub-agent.",
    states: [
      {
        kind: "agent",
        name: "say_done",
        ...agentState,
        prompt: "Reply with exactly the word DONE and nothing else.",
      },
      {
        kind: "terminal",
        name: "done",
        status: "completed",
        reason: "Agent model eval completed.",
      },
    ],
  };
}

function makeRunner(definition: StateMachineDefinition): CapturingRunner {
  return new CapturingRunner({
    model: runnerModel,
    mode: definition,
    skillDiscovery: { includeDefaults: false },
    systemInstructions: [
      "This is a live eval. Use select_state_machine_state for every transition.",
      "Do not override the agent state; rely on the definition values.",
      "On the initial prompt, select say_done without input.",
      "After say_done completes, select done.",
    ].join("\n"),
  });
}

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

describe("state machine agent state model", () => {
  testIfDocker(
    "runs the sub-agent on the per-state model and thinkingLevel",
    async () => {
      const definition = buildDefinition({
        model: stateModel,
        thinkingLevel: stateThinkingLevel,
      });
      const runner = makeRunner(definition);

      const started = await startTurn(runner, {
        mode: definition,
        prompt: "Start the agent model eval.",
      });
      const terminal = await started.turn;

      expectCompleted(terminal);
      // The sub-agent must have been created with the overridden model and
      // thinking level, not the parent runner's.
      expect(runner.stateAgentOptions).toContainEqual({
        model: stateModel,
        thinkingLevel: stateThinkingLevel,
      });
    },
    150_000,
  );

  testIfDocker(
    "falls back to the parent model when the agent state omits the override",
    async () => {
      const definition = buildDefinition({});
      const runner = makeRunner(definition);

      const started = await startTurn(runner, {
        mode: definition,
        prompt: "Start the agent model eval.",
      });
      const terminal = await started.turn;

      expectCompleted(terminal);
      // No per-state override: the sub-agent inherits the runner's model, and
      // never the alternate model the green case used. This is the
      // falsification check — if the override path leaked into the no-override
      // definition, stateModel would show up here.
      expect(runner.stateAgentOptions.length).toBeGreaterThan(0);
      for (const options of runner.stateAgentOptions) {
        expect(options.model).toBe(runnerModel);
        expect(options.model).not.toBe(stateModel);
      }
    },
    150_000,
  );
});
