import { describe, expect, test } from "bun:test";
import { planDecision, startSession } from "../src/turn-runner/state-machine-decisions.js";
import type { StateMachineRunnerDecision } from "../src/turn-runner/tools.js";
import type { StateMachineDefinition, StateMachineSession } from "../src/types/state-machine.js";

/**
 * select_state_machine_state overrides persist into the active definition
 * by default, so that re-running the same state automatically picks up the
 * tuned prompt/command/schedule. The orchestrator opts out by passing
 * `persistOverride: false` for one-shot exploration.
 */
describe("state-machine override persistence", () => {
  test("persists an agent prompt override into the definition by default", () => {
    const definition: StateMachineDefinition = {
      name: "persist",
      prompt: "Run.",
      states: [{ kind: "agent", name: "work", prompt: "original prompt" }],
    };

    const promptsSeen: string[] = [];
    let currentSession = startSession({
      prompt: "Run.",
      definition,
      currentState: "work",
    });

    // First run: override the prompt. Default persistOverride applies.
    currentSession = planAgentDecision(
      currentSession,
      {
        state: "work",
        override: { kind: "agent", state: { prompt: "tuned prompt" } },
      },
      promptsSeen,
    );

    // Second run: no override. The persisted definition must already carry
    // the tuned prompt, so the sub-agent sees the tuned version.
    currentSession = planAgentDecision(currentSession, { state: "work" }, promptsSeen);

    expect(promptsSeen).toEqual(["tuned prompt", "tuned prompt"]);
    const session = currentSession;
    expect(session?.definition.states[0]).toMatchObject({
      name: "work",
      prompt: "tuned prompt",
    });
    const updates = (session?.history ?? []).filter(
      (event) => event.type === "state_definition_updated",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      type: "state_definition_updated",
      state: "work",
      updatedState: { name: "work", kind: "agent", prompt: "tuned prompt" },
    });
  });

  test("persistOverride: false applies the override one-shot and leaves the definition unchanged", () => {
    const definition: StateMachineDefinition = {
      name: "ephemeral",
      prompt: "Run.",
      states: [{ kind: "agent", name: "work", prompt: "original prompt" }],
    };

    const promptsSeen: string[] = [];
    let currentSession = startSession({
      prompt: "Run.",
      definition,
      currentState: "work",
    });

    currentSession = planAgentDecision(
      currentSession,
      {
        state: "work",
        override: { kind: "agent", state: { prompt: "probe prompt" } },
        persistOverride: false,
      },
      promptsSeen,
    );

    // No override on the second run: definition is unchanged, so the
    // sub-agent sees the original prompt again.
    currentSession = planAgentDecision(currentSession, { state: "work" }, promptsSeen);

    expect(promptsSeen).toEqual(["probe prompt", "original prompt"]);
    const session = currentSession;
    expect(session?.definition.states[0]).toMatchObject({
      name: "work",
      prompt: "original prompt",
    });
    const updates = (session?.history ?? []).filter(
      (event) => event.type === "state_definition_updated",
    );
    expect(updates).toHaveLength(0);
  });
});

function planAgentDecision(
  session: StateMachineSession,
  decision: StateMachineRunnerDecision,
  promptsSeen: string[],
): StateMachineSession {
  const planned = planDecision(session, decision);
  if (!("run" in planned.work) || !("subagent" in planned.work.run)) {
    throw new Error(`Expected agent work for state "${decision.state}".`);
  }
  promptsSeen.push(planned.work.run.subagent.prompt);
  return planned.session;
}
