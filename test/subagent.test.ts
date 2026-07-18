import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ClassifierInput } from "../src/model-routing/classifier.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { ModelRouter } from "../src/model-routing/router.js";
import { classifySpawnModel, type SubagentRun } from "../src/turn-runner/subagent.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnState } from "../src/types/protocol.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";

const resolveCatalog = { modelAcceptsImages: () => true };

function poisonedModelRouter(): ModelRouter {
  const router = new ModelRouter({
    table: BUILT_IN_ROUTING_TABLE,
    tier: "frontier",
    classify: async () => ({ route: "general", rationale: "Unused poison dependency." }),
    resolveCatalog,
  });
  return new Proxy(router, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return () => {
        throw new Error(`Shared ModelRouter.${String(property)} must not be called.`);
      };
    },
  });
}

class PoisonedRouterTurnRunner extends TurnRunner {
  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.prompt = (async () => {}) as typeof agent.prompt;
    return agent;
  }

  poisonRouterAndSelectVirtualParent(): void {
    const state = this.getState();
    if (!state) throw new Error("Runner must be started before poisoning its router.");
    (this as unknown as { state: TurnState }).state = {
      ...state,
      options: { ...state.options, model: "frontier" },
    };
    this.modelRouter = poisonedModelRouter();
  }

  runStateAgent(state: StateMachineAgentState): SubagentRun {
    return this.createStateSubagentRun({ state, prompt: state.prompt });
  }
}

describe("sub-agent model routing isolation", () => {
  test("state-agent execution inherits the active concrete parent without touching ModelRouter", async () => {
    const runner = new PoisonedRouterTurnRunner({
      model: "anthropic:claude-opus-4-8",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    await runner.start({ type: "start", mode: "agent" });
    runner.poisonRouterAndSelectVirtualParent();

    const result = await runner
      .runStateAgent({ kind: "agent", name: "child", prompt: "Do the child task." })
      .prompt();

    expect(result).toEqual({ type: "complete", result: "" });
    await runner.dispose();
  });

  test("classifySpawnModel inherits concrete settings and classifies a virtual setting once", async () => {
    const inputs: ClassifierInput[] = [];
    const classify = async (input: ClassifierInput) => {
      inputs.push(input);
      return { route: "implement", rationale: "The child is implementing code." };
    };
    const deps = {
      table: BUILT_IN_ROUTING_TABLE,
      resolveCatalog,
      classifierOptions: { model: "gpt-5.6-luna" },
      classify,
    };

    await expect(classifySpawnModel("Write the patch.", "gpt-5.6-sol", deps)).resolves.toEqual({
      modelName: "gpt-5.6-sol",
    });
    expect(inputs).toHaveLength(0);

    await expect(classifySpawnModel("Write the patch.", "frontier", deps)).resolves.toEqual({
      modelName: BUILT_IN_ROUTING_TABLE.tiers.frontier.routes.implement!.target.modelName,
      thinkingLevel: BUILT_IN_ROUTING_TABLE.tiers.frontier.routes.implement!.target.thinkingLevel,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.lastStepDelta).toBe("Write the patch.");
  });
});
