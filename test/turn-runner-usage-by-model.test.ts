import { describe, expect, spyOn, test } from "bun:test";
import * as structuredOutput from "../src/core/structured-output.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTerminalEvent, TurnTokenUsage } from "../src/types/protocol.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { SubagentSpec } from "../src/turn-runner/subagent.js";
import type { TaskId } from "../src/tasks/types.js";
import { createOutreachStateMachine } from "./helpers/turn-runner-protocol.js";

const STATE_MODEL_ID = "test-state-model/v1";

const PARENT_USAGE: TurnTokenUsage = {
  input: 500,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 600,
  cost: { input: 0.08, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.1 },
};

const STATE_USAGE: TurnTokenUsage = {
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1200,
  cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

const CHILD_USAGE: TurnTokenUsage = {
  input: 300,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 350,
  cost: { input: 0.03, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
};

const CLASSIFIER_USAGE: TurnTokenUsage = {
  input: 80,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100,
  cost: { input: 0.008, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.02 },
};

/**
 * Drives the real `TurnRunner` turn loop with two stubbed model boundaries:
 * the parent worker records `PARENT_USAGE` (attributed to the configured
 * parent model via the real `recordUsage` path), and a
 * state-machine agent state reports `STATE_USAGE` under a *different* model id
 * through the real `recordUsage` per-model accumulation path. This exercises
 * the outermost per-model attribution wiring without standing up a live LLM,
 * so a regression that drops the model id or the state-agent attribution
 * surfaces in `usageByModel`.
 */
class MultiModelTurnRunner extends TurnRunner {
  private workerCalls = 0;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerCalls += 1;
    if (this.workerCalls === 1) {
      // First parent turn: select the agent state and record parent usage the
      // way a real parent run would — production folds usage in from the live
      // `Agent`'s `message_end`, so this stub attributes it to the parent model
      // itself rather than leaning on any worker-boundary accounting.
      this.recordUsage(PARENT_USAGE, this.requireParentAgent().state.model.id);
      this.emitTurnUsage();
      return {
        control: {
          type: "select_state_machine_state",
          decision: { state: "research_prospect" },
        },
        outcome: {
          type: "complete",
          status: "completed",
          result: "Selected research state.",
          state: { ...input.state, status: "completed" },
        },
      };
    }
    // Wrap-up turn after the state agent runs; no further parent usage.
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "Wrapped up.",
        state: {
          ...input.state,
          status: "completed",
          agent: { ...input.state.agent, status: "completed" },
        },
      },
    };
  }

  protected override createStateSubagentRun(): SubagentRun {
    // Mirror production's invariant that a parent emission precedes the state
    // agent, so the runner's sidebar rescale has a base snapshot to work from.
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: 200_000,
      contextWindowUsage: { systemPrompt: 100, messages: 200, localMemory: 0, globalMemory: 0 },
      lastMessageUsage: {
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 300,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    return {
      prompt: async () => {
        try {
          this.emitAgentEvent({
            type: "message_update",
            message: { role: "assistant" } as never,
            assistantMessageEvent: {
              type: "text_end",
              contentIndex: 0,
              content: "stubbed state agent",
              partial: { role: "assistant" } as never,
            },
          } satisfies AgentEvent);
          return { type: "complete", result: "State agent finished." };
        } finally {
          // The real handle attributes state-agent usage to the state agent's
          // own model id; here that id differs from the parent model, so the
          // turn ends with two distinct `usageByModel` entries.
          this.recordUsage(STATE_USAGE, STATE_MODEL_ID);
          this.emitTurnUsage();
        }
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

class ConcurrentSpawnUsageRunner extends TurnRunner {
  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: 200_000,
      contextWindowUsage: { systemPrompt: 100, messages: 200, localMemory: 0, globalMemory: 0 },
      lastMessageUsage: PARENT_USAGE,
    };
    this.recordUsage(PARENT_USAGE, this.requireParentAgent().state.model.id);
    this.emitTurnUsage();
    const spawn = this.createTools("agent").tools.find((tool) => tool.name === "spawn_agent");
    if (!spawn) throw new Error("spawn_agent missing");
    await Promise.all([
      spawn.execute("spawn-a", { prompt: "first child" }),
      spawn.execute("spawn-b", { prompt: "second child" }),
    ]);
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "children complete",
        state: { ...input.state, status: "completed" },
      },
    };
  }

  protected override async createSpawnedSubagentRun(
    spec: SubagentSpec,
    taskId: TaskId,
  ): Promise<SubagentRun> {
    return {
      prompt: async () => {
        await Promise.resolve();
        this.recordUsage(CHILD_USAGE, `fake-child/${taskId}`);
        this.emitTurnUsage({ taskId });
        return { type: "complete", result: `${taskId}: ${spec.prompt}` };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

class ClassifierUsageRunner extends TurnRunner {
  constructor() {
    super({ model: "balanced", skillDiscovery: { includeDefaults: false } });
  }

  protected override async runAgentWorker(rawInput: AgentWorkerInput): Promise<AgentWorkerResult> {
    const input = this.prepareParentPassInput(rawInput);
    await this.selectSpawnModel("Implement the patch.", "balanced");
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "classified",
        state: { ...input.state, status: "completed" },
      },
    };
  }
}

describe("TurnRunner per-model cost breakdown", () => {
  test("holds classifier usage for the flat terminal when no parent snapshot exists", async () => {
    const priorKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "duet_gt_classifier_usage";
    const generate = spyOn(structuredOutput, "generateStructuredOutput").mockImplementation(
      async (options) => {
        options.onUsage?.(CLASSIFIER_USAGE);
        return { route: "implement", rationale: "Implementation work." } as never;
      },
    );
    try {
      const runner = new ClassifierUsageRunner();
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      await runner.start({ type: "start", mode: "agent" });

      const terminal = await runner.turn({
        type: "prompt",
        message: "classify child",
        behavior: "follow_up",
      });

      const streamed = events.find(
        (event): event is Extract<TurnEvent, { type: "usage" }> => event.type === "usage",
      );
      expect(streamed).toBeUndefined();
      expect(terminal.turnUsage).toEqual(CLASSIFIER_USAGE);
      expect(terminal.usageByModel).toEqual([
        {
          model: resolveModelName(BUILT_IN_ROUTING_TABLE.classifier.target.modelName).id,
          usage: CLASSIFIER_USAGE,
        },
      ]);
      await runner.dispose();
    } finally {
      generate.mockRestore();
      if (priorKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = priorKey;
    }
  });

  test("attributes a mixed-model relay turn to per-model entries that sum to the turn total", async () => {
    const runner = new MultiModelTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: createOutreachStateMachine() });

    const terminal = (await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    })) as TurnTerminalEvent;

    expect(terminal.type).toBe("complete");
    const turnUsage = terminal.turnUsage;
    const usageByModel = terminal.usageByModel;
    expect(turnUsage).toBeDefined();
    expect(usageByModel).toBeDefined();

    // Two distinct models contributed this turn: the parent worker model and
    // the state agent's model.
    expect(usageByModel!).toHaveLength(2);
    const models = usageByModel!.map((entry) => entry.model);
    expect(models).toContain(STATE_MODEL_ID);

    const stateEntry = usageByModel!.find((entry) => entry.model === STATE_MODEL_ID);
    expect(stateEntry?.usage).toEqual(STATE_USAGE);

    const parentEntry = usageByModel!.find((entry) => entry.model !== STATE_MODEL_ID);
    expect(parentEntry?.usage).toEqual(PARENT_USAGE);

    // Core invariant: per-model cost totals reconstruct the turn total.
    const summed = usageByModel!.reduce((acc, entry) => acc + entry.usage.cost.total, 0);
    expect(summed).toBeCloseTo(turnUsage!.cost.total, 10);
    expect(summed).toBeCloseTo(0.35, 10);
  });

  test("two concurrent spawned children contribute task-origin usage that sums to the turn aggregate", async () => {
    const runner = new ConcurrentSpawnUsageRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: "agent" });

    const terminal = await runner.turn({
      type: "prompt",
      message: "spawn both",
      behavior: "follow_up",
    });

    expect(terminal.type).toBe("complete");
    const taskUsage = events.filter(
      (event): event is Extract<TurnEvent, { type: "usage" }> =>
        event.type === "usage" && event.origin !== undefined,
    );
    expect(taskUsage.map((event) => event.origin?.taskId)).toEqual(["t1", "t2"]);
    const allUsage = events.filter(
      (event): event is Extract<TurnEvent, { type: "usage" }> => event.type === "usage",
    );
    let previousTotal = 0;
    const taskDeltas = new Map<string, number>();
    for (const event of allUsage) {
      const delta = event.turnUsage.cost.total - previousTotal;
      previousTotal = event.turnUsage.cost.total;
      if (event.origin) taskDeltas.set(event.origin.taskId, delta);
    }
    for (const delta of taskDeltas.values()) expect(delta).toBeCloseTo(0.05, 10);
    expect(terminal.usageByModel!.map((entry) => entry.model)).toEqual(
      expect.arrayContaining(["fake-child/t1", "fake-child/t2"]),
    );
    const perModelTotal = terminal.usageByModel!.reduce(
      (sum, entry) => sum + entry.usage.cost.total,
      0,
    );
    expect(perModelTotal).toBeCloseTo(terminal.turnUsage!.cost.total, 10);
    expect(
      PARENT_USAGE.cost.total + [...taskDeltas.values()].reduce((a, b) => a + b, 0),
    ).toBeCloseTo(terminal.turnUsage!.cost.total, 10);
    expect(perModelTotal).toBeCloseTo(0.2, 10);
    await runner.dispose();
  });
});
