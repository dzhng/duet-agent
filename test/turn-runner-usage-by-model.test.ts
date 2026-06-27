import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnTerminalEvent, TurnTokenUsage } from "../src/types/protocol.js";
import type { StateAgentHandle } from "../src/turn-runner/state-machine-controller.js";
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

  protected override createStateAgentHandle(): StateAgentHandle {
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

describe("TurnRunner per-model cost breakdown", () => {
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
});
