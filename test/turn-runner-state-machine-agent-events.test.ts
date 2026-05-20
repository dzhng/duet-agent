import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type {
  TurnEvent,
  TurnStepEvent,
  TurnUsageEvent,
  TurnTokenUsage,
} from "../src/types/protocol.js";
import type { StateAgentHandle } from "../src/turn-runner/state-machine-controller.js";
import { createOutreachStateMachine } from "./helpers/turn-runner-protocol.js";

class StateMachineAgentEventTurnRunner extends TurnRunner {
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

    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "State-agent state complete.",
        state: {
          ...input.state,
          status: "completed",
          agent: {
            ...input.state.agent,
            status: "completed",
          },
        },
      },
    };
  }

  protected override createStateAgentHandle(): StateAgentHandle {
    return {
      prompt: async () => {
        this.emitAgentEvent({
          type: "message_update",
          message: { role: "assistant" } as never,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "State agent",
            partial: { role: "assistant" } as never,
          },
        } satisfies AgentEvent);
        this.emitAgentEvent({
          type: "message_update",
          message: { role: "assistant" } as never,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "State agent researched the prospect.",
            partial: { role: "assistant" } as never,
          },
        } satisfies AgentEvent);
        this.emitAgentEvent({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "profile.md" },
        });
        return { type: "complete", result: "State-agent state complete." };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

describe("State-machine agent state events", () => {
  test("emits state-agent step events through the parent runner subscription", async () => {
    const runner = new StateMachineAgentEventTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: createOutreachStateMachine() });

    await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(events).toContainEqual({
      type: "step",
      step: { type: "text_delta", delta: "State agent" },
    });
    expect(events).toContainEqual({
      type: "step",
      step: { type: "text", text: "State agent researched the prospect." },
    });
    expect(events).toContainEqual({
      type: "step",
      step: {
        type: "tool_call",
        toolName: "read",
        toolCallId: "tool-1",
        status: "running",
        input: { path: "profile.md" },
      },
    });
  });

  test("tags state-agent step + usage events with their originating agent state", async () => {
    const runner = new StateMachineOriginTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: createOutreachStateMachine() });

    await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    });

    const stepsWithOrigin = events.filter(
      (event): event is TurnStepEvent => event.type === "step" && event.origin !== undefined,
    );
    expect(stepsWithOrigin.length).toBeGreaterThan(0);
    for (const step of stepsWithOrigin) {
      expect(step.origin).toEqual({
        kind: "state_machine_agent",
        state: "research_prospect",
      });
    }

    const usageWithOrigin = events.filter(
      (event): event is TurnUsageEvent => event.type === "usage" && event.origin !== undefined,
    );
    expect(usageWithOrigin.length).toBeGreaterThan(0);
    for (const usage of usageWithOrigin) {
      expect(usage.origin).toEqual({
        kind: "state_machine_agent",
        state: "research_prospect",
      });
    }
  });

  test("emits a usage event after each state-agent finish, monotonically advancing turn cost", async () => {
    const runner = new StateMachineUsageTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: createOutreachStateMachine() });

    await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    });

    const usageEvents = events.filter((e): e is TurnUsageEvent => e.type === "usage");
    // One state-agent finishes during the turn; the stubbed parent worker
    // never emits a parent assistant `message_end`, so the only `usage` event
    // comes from the state-agent emission path.
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    expect(usageEvents[0]!.turnUsage.cost.total).toBeCloseTo(0.25, 6);

    const lastUsage = usageEvents.at(-1)!;
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("complete");
    // Terminal event carries the same aggregate as the last `usage` event,
    // proving the single-source-of-truth invariant.
    if (terminal && "turnUsage" in terminal && terminal.turnUsage) {
      expect(terminal.turnUsage.cost.total).toBeCloseTo(lastUsage.turnUsage.cost.total, 6);
    }
  });

  test("records state-agent usage even when the state-agent prompt throws", async () => {
    const runner = new StateMachineUsageTurnRunner({ throwAfterUsage: true });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: createOutreachStateMachine() });

    await runner.turn({
      type: "prompt",
      message: "Continue.",
      behavior: "follow_up",
    });

    const usageEvents = events.filter((e): e is TurnUsageEvent => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
    // The error path runs through the same `finally`, so partial usage still
    // lands as a `usage` event.
    expect(usageEvents.at(-1)!.turnUsage.cost.total).toBeCloseTo(0.25, 6);
  });
});

/**
 * Test double whose state-agent handle records a fixed `TurnTokenUsage`
 * before returning, exercising the real `recordUsage` + `emitTurnUsage`
 * path in `createStateAgentHandle` without standing up a live LLM. The
 * parent worker stub is unchanged from {@link StateMachineAgentEventTurnRunner};
 * it picks a state and then `none`s out so the turn finishes after the state
 * agent runs.
 */
class StateMachineUsageTurnRunner extends TurnRunner {
  private workerCalls = 0;
  private readonly throwAfterUsage: boolean;

  constructor(options: { throwAfterUsage?: boolean } = {}) {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    this.throwAfterUsage = options.throwAfterUsage ?? false;
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerCalls += 1;
    if (this.workerCalls === 1) {
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
    const stubbedUsage: TurnTokenUsage = {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    };
    // `runAgentWorker` is stubbed so no real `message_end` fires from the
    // parent. Seed the snapshot to match production's invariant that the
    // state agent always runs after a parent emission.
    // `lastMessageUsage.totalTokens` must equal the four `contextWindowUsage`
    // segments summed (the runner's rescale invariant); keep both in sync
    // when changing the stub.
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
      // Mirrors the real handle's structure: side effects of running the
      // state agent happen inside try, and `recordUsage` + `emitTurnUsage`
      // run in `finally` so error/interrupt paths still surface usage.
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
          if (this.throwAfterUsage) {
            throw new Error("simulated state-agent failure");
          }
          return { type: "complete", result: "State agent finished." };
        } catch (error) {
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
          this.recordUsage(stubbedUsage);
          this.emitTurnUsage();
        }
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

/**
 * Stub state-agent handle that emits both a step event and a usage event with
 * a `state_machine_agent` origin, mirroring what the real
 * `createStateAgentHandle` does after this change. Used to assert the runner's
 * emit pipeline forwards the origin onto every event it produces, without
 * standing up a live LLM.
 */
class StateMachineOriginTurnRunner extends TurnRunner {
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
    const stubbedUsage: TurnTokenUsage = {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1200,
      cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    };
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
    const origin = { kind: "state_machine_agent" as const, state: "research_prospect" };
    return {
      prompt: async () => {
        try {
          this.emitAgentEvent(
            {
              type: "message_update",
              message: { role: "assistant" } as never,
              assistantMessageEvent: {
                type: "text_end",
                contentIndex: 0,
                content: "stubbed state agent",
                partial: { role: "assistant" } as never,
              },
            } satisfies AgentEvent,
            origin,
          );
          return { type: "complete", result: "State agent finished." };
        } finally {
          this.recordUsage(stubbedUsage);
          this.emitTurnUsage(origin);
        }
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}
