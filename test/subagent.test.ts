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
  childToolNames: string[] = [];

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    if (input.prependSystemPrompt) this.childToolNames = input.tools.map((tool) => tool.name);
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

class LiveSpawnTurnRunner extends TurnRunner {
  readonly childInputs: AgentConfigInput[] = [];
  readonly selections: Array<{ prompt: string; parentSetting: string }> = [];

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    if (input.memoryContext) this.childInputs.push(input);
    agent.prompt = (async () => {}) as typeof agent.prompt;
    return agent;
  }

  protected override async selectSpawnModel(prompt: string, parentSetting: string) {
    this.selections.push({ prompt, parentSetting });
    return { modelName: "anthropic:claude-sonnet-4-6" };
  }

  poisonRouterAndOpenScope(): void {
    const state = this.getState();
    if (!state) throw new Error("Runner must be started before spawning.");
    (this as unknown as { state: TurnState }).state = {
      ...state,
      options: { ...state.options, model: "frontier" },
    };
    this.modelRouter = poisonedModelRouter();
    (this as unknown as { activeRootScopeId: string }).activeRootScopeId = "root";
  }

  spawn(prompt: string) {
    const tool = this.createTools("agent").tools.find(
      (candidate) => candidate.name === "spawn_agent",
    );
    if (!tool) throw new Error("spawn_agent tool missing");
    return tool.execute(`spawn-${prompt}`, { prompt });
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
    expect(runner.childToolNames).not.toContain("ask_user_question");
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

  test("live spawn classifies the virtual parent once without the shared router and isolates child tools", async () => {
    const runner = new LiveSpawnTurnRunner({
      model: "anthropic:claude-opus-4-7",
      mode: "agent",
      memoryDbPath: false,
      sessionId: "parent-session",
      skillDiscovery: { includeDefaults: false },
    });
    await runner.start({ type: "start", mode: "agent" });
    runner.poisonRouterAndOpenScope();

    const [first, second] = await Promise.all([
      runner.spawn("Audit auth."),
      runner.spawn("Audit billing."),
    ]);
    expect(first.content[0]).toMatchObject({ type: "text" });
    expect(second.content[0]).toMatchObject({ type: "text" });
    expect(runner.selections).toEqual([
      { prompt: "Audit auth.", parentSetting: "frontier" },
      { prompt: "Audit billing.", parentSetting: "frontier" },
    ]);
    expect(runner.childInputs).toHaveLength(2);
    expect(runner.childInputs.map((input) => input.memoryContext?.sessionId)).toEqual([
      "parent-session:sub:t1",
      "parent-session:sub:t2",
    ]);
    expect(runner.childInputs[0]?.memoryContext?.horizon).not.toBe(
      runner.childInputs[1]?.memoryContext?.horizon,
    );
    runner.childInputs[0]!.memoryContext!.horizon.evictionHorizon = 7;
    expect(runner.childInputs[1]?.memoryContext?.horizon.evictionHorizon).toBe(0);
    for (const input of runner.childInputs) {
      const names = input.tools.map((tool) => tool.name);
      expect(names).toContain("spawn_agent");
      expect(names).toContain("task_output");
      expect(names).toContain("task_stop");
      expect(names).not.toContain("ask_user_question");
    }
    await runner.dispose();
  });
});
