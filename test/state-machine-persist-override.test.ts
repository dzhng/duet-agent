import { describe, expect, test } from "bun:test";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

/**
 * select_state_machine_state overrides persist into the active definition
 * by default, so that re-running the same state automatically picks up the
 * tuned prompt/command/schedule. The orchestrator opts out by passing
 * `persistOverride: false` for one-shot exploration.
 */
describe("state-machine override persistence", () => {
  test("persists an agent prompt override into the definition by default", async () => {
    const definition: StateMachineDefinition = {
      name: "persist",
      prompt: "Run.",
      states: [{ kind: "agent", name: "work", prompt: "original prompt" }],
    };

    const promptsSeen: string[] = [];
    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: ({ prompt }) => {
        promptsSeen.push(prompt);
        return {
          prompt: async () => ({ type: "complete", result: "ok" }),
          interrupt: () => {},
          partialAssistantText: () => undefined,
          interruptedReason: () => undefined,
        };
      },
    });
    controller.startSession({
      prompt: "Run.",
      definition,
      currentState: "work",
    });

    // First run: override the prompt. Default persistOverride applies.
    await controller.runDecision({
      state: "work",
      override: { kind: "agent", state: { prompt: "tuned prompt" } },
    });

    // Second run: no override. The persisted definition must already carry
    // the tuned prompt, so the sub-agent sees the tuned version.
    await controller.runDecision({ state: "work" });

    expect(promptsSeen).toEqual(["tuned prompt", "tuned prompt"]);
    const session = controller.getSession();
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

  test("persistOverride: false applies the override one-shot and leaves the definition unchanged", async () => {
    const definition: StateMachineDefinition = {
      name: "ephemeral",
      prompt: "Run.",
      states: [{ kind: "agent", name: "work", prompt: "original prompt" }],
    };

    const promptsSeen: string[] = [];
    const controller = new StateMachineController({
      cwd: process.cwd(),
      createStateAgent: ({ prompt }) => {
        promptsSeen.push(prompt);
        return {
          prompt: async () => ({ type: "complete", result: "ok" }),
          interrupt: () => {},
          partialAssistantText: () => undefined,
          interruptedReason: () => undefined,
        };
      },
    });
    controller.startSession({
      prompt: "Run.",
      definition,
      currentState: "work",
    });

    await controller.runDecision({
      state: "work",
      override: { kind: "agent", state: { prompt: "probe prompt" } },
      persistOverride: false,
    });

    // No override on the second run: definition is unchanged, so the
    // sub-agent sees the original prompt again.
    await controller.runDecision({ state: "work" });

    expect(promptsSeen).toEqual(["probe prompt", "original prompt"]);
    const session = controller.getSession();
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
