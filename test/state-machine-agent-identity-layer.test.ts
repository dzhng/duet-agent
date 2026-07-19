import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { createStateAgentSystemPromptLayer } from "../src/turn-runner/prompts.js";
import { startSession as startStateMachineSession } from "../src/turn-runner/state-machine-decisions.js";
import type { StateMachineAgentState, StateMachineDefinition } from "../src/types/state-machine.js";
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

// Minimal "started" runner state so createStateSubagentRun can read
// requireRunnerState().options without driving a full live turn.
const RUNNING_STATE: TurnState = {
  status: "running",
  mode: "agent",
  options: {},
  agent: { status: "running", messages: [] },
};

/**
 * Builds a sub-agent through the real createStateSubagentRun path and returns
 * the fully composed system prompt that the sub-agent would run under. Pass
 * `machineContext` to install an active session first, exercising the wiring
 * that threads the running machine into the sub-agent's prompt.
 */
function composeSubAgentSystemPrompt(
  state: StateMachineAgentState,
  machineContext?: { definition: StateMachineDefinition; currentState: string },
): string {
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
  // Optionally install an active policy ledger so the production wiring is the
  // path under test, not just the layer function in isolation.
  if (machineContext) {
    (runner as unknown as { stateMachine: unknown }).stateMachine = startStateMachineSession({
      prompt: "Start.",
      definition: machineContext.definition,
      currentState: machineContext.currentState,
    });
  }
  (
    runner as unknown as {
      createStateSubagentRun: (input: {
        state: StateMachineAgentState;
        prompt: string;
        origin: { taskId: "t1" };
      }) => unknown;
    }
  ).createStateSubagentRun({
    state,
    prompt: state.prompt,
    origin: { taskId: "t1" },
  });

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

  test("the layer situates the sub-agent in the machine and names its current state", () => {
    const layer = createStateAgentSystemPromptLayer({
      definition: {
        name: "Ship the feature",
        prompt: "Plan, implement, and verify the requested change.",
        states: [
          { kind: "agent", name: "plan", prompt: "Draft the plan.", when: "before any code" },
          { kind: "agent", name: "implement", prompt: "Write the code." },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      },
      currentState: "plan",
    });

    // Overall goal and machine name give the sub-agent the bigger picture.
    expect(layer).toContain("Ship the feature");
    expect(layer).toContain("Plan, implement, and verify the requested change.");
    // Every state is listed by name and kind, with `when` guidance carried through.
    expect(layer).toContain("- plan (agent) — before any code");
    expect(layer).toContain("- implement (agent)");
    expect(layer).toContain("- done (terminal)");
    // The current state is marked and named so the sub-agent knows its boundary.
    expect(layer).toContain("← YOU ARE HERE");
    expect(layer).toContain('executing ONLY the "plan" state');
    // The downstream over-reach this prevents: a planning state implementing.
    expect(layer).toContain("do not start implementing what a later state is meant to build");
  });

  test("the machine context is only emitted with an active definition", () => {
    expect(createStateAgentSystemPromptLayer()).not.toContain("state_machine_context");
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

  test("createStateSubagentRun threads the active machine into the sub-agent prompt", () => {
    const definition: StateMachineDefinition = {
      name: "Ship the feature",
      prompt: "Plan, implement, and verify the requested change.",
      states: [
        { kind: "agent", name: "plan", prompt: "Draft the plan.", when: "before any code" },
        { kind: "agent", name: "implement", prompt: "Write the code." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const composed = composeSubAgentSystemPrompt(
      { kind: "agent", name: "plan", prompt: "Draft the plan." },
      { definition, currentState: "plan" },
    );

    // The wiring — not just the layer function — surfaces the machine context:
    // turn-runner reads the active session and passes it through, so reverting
    // that call to the no-arg form fails here, offline, instead of only in the
    // slow live eval.
    expect(composed).toContain("state_machine_context");
    expect(composed).toContain("Ship the feature");
    expect(composed).toContain("- implement (agent)");
    expect(composed).toContain('executing ONLY the "plan" state');
  });
});
