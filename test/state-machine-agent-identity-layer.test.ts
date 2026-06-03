import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { createStateAgentSystemPromptLayer } from "../src/turn-runner/prompts.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import type { TurnState } from "../src/types/protocol.js";

/**
 * Deterministic guard for the sub-agent identity fix. The live eval
 * (`evals/state-machine-agent-keeps-task-identity.eval.ts`) proves the model
 * behavior on opus-4.8, but it is slow and model-dependent; these tests pin
 * the wiring so a regression that drops or demotes the layer fails fast and
 * offline.
 */

// Sentinel standing in for the host chat-assistant persona. The whole point of
// the fix is that the worker identity must come BEFORE this in the composed
// system prompt.
const HOST_PERSONA = "HOST_CHAT_PERSONA_SENTINEL";

// Minimal "started" runner state so createStateAgentHandle can read
// requireRunnerState().options without driving a full live turn.
const RUNNING_STATE: TurnState = {
  status: "running",
  mode: "agent",
  options: {},
  agent: { status: "running", messages: [] },
};

/**
 * Builds a sub-agent through the real createStateAgentHandle path and returns
 * the fully composed system prompt that the sub-agent would run under.
 */
function composeSubAgentSystemPrompt(state: StateMachineAgentState): string {
  let composed: string | undefined;

  class CapturingTurnRunner extends TurnRunner {
    constructor() {
      super({
        model: "anthropic:claude-opus-4-8",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: HOST_PERSONA,
      });
    }

    // Capture the system prompt the real createAgent actually composed (read
    // back off the constructed Agent), not a re-derivation — so a regression in
    // how createAgent wires prepend/append is what this test catches. No
    // network happens until prompt(), so building the Agent is cheap.
    protected override createAgent(
      input: AgentConfigInput,
      onControlResult?: (result: TurnRunnerControlResult) => void,
    ): Agent {
      const agent = super.createAgent(input, onControlResult);
      composed = agent.state.systemPrompt;
      return agent;
    }
  }

  const runner = new CapturingTurnRunner();
  (runner as unknown as { state: TurnState }).state = RUNNING_STATE;
  (
    runner as unknown as {
      createStateAgentHandle: (input: { state: StateMachineAgentState; prompt: string }) => unknown;
    }
  ).createStateAgentHandle({ state, prompt: state.prompt });

  if (composed === undefined) throw new Error("createAgent was not invoked");
  return composed;
}

describe("state agent identity layer", () => {
  test("the layer forbids standing down as a chat assistant with no message", () => {
    const layer = createStateAgentSystemPromptLayer();
    expect(layer).toContain("sub-agent executing a single state");
    expect(layer).toContain("the prompt IS the task");
    // The exact drift the fix prevents: treating empty-thread subject matter
    // as the sub-agent's own "nothing to act on" situation.
    expect(layer).toContain("never reply that you don't see a message");
  });

  test("the worker identity leads the sub-agent system prompt, ahead of the host persona", () => {
    const composed = composeSubAgentSystemPrompt({
      kind: "agent",
      name: "build_fixture",
      prompt: "Produce the fixture descriptor.",
    });

    const identityIndex = composed.indexOf("state_agent_identity");
    const personaIndex = composed.indexOf(HOST_PERSONA);

    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(personaIndex).toBeGreaterThanOrEqual(0);
    // Precedence is the whole fix: the worker identity must be the primary
    // role, so it has to appear before the inherited chat persona.
    expect(identityIndex).toBeLessThan(personaIndex);
  });

  test("a per-state systemPrompt refines the identity rather than replacing it", () => {
    const stateSystemPrompt = "STATE_SPECIFIC_FRAMING_42";
    const composed = composeSubAgentSystemPrompt({
      kind: "agent",
      name: "build_fixture",
      prompt: "Produce the fixture descriptor.",
      systemPrompt: stateSystemPrompt,
    });

    const identityIndex = composed.indexOf("state_agent_identity");
    const personaIndex = composed.indexOf(HOST_PERSONA);
    const stateIndex = composed.indexOf(stateSystemPrompt);

    // Identity still leads; the per-state framing is appended after the base
    // prompt (and after the host persona), so it tunes an already-established
    // worker identity instead of competing to define it.
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBeGreaterThan(personaIndex);
    expect(identityIndex).toBeLessThan(stateIndex);
  });
});
