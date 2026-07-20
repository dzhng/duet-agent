import { describe, expect, test } from "bun:test";
import { startTurn } from "./helpers/turn-runner-protocol.js";
import assert from "node:assert";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { waitFor } from "./helpers/async.js";

class InterruptTurnRunner extends TurnRunner {
  streamStarted: Promise<void>;
  private resolveStreamStarted!: () => void;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    this.streamStarted = new Promise((resolve) => {
      this.resolveStreamStarted = resolve;
    });
  }

  protected override createAgent(input: AgentConfigInput): Agent {
    return new Agent({
      initialState: {
        model: { provider: "unknown", id: "test" } as never,
        thinkingLevel: input.state.options?.thinkingLevel ?? "medium",
        systemPrompt: input.appendSystemPrompt ?? "",
        messages: input.state.agent.messages,
        tools: input.tools,
      },
      streamFn: this.createInterruptibleStream(),
    });
  }

  private createInterruptibleStream(): StreamFn {
    return (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      this.resolveStreamStarted();
      options?.signal?.addEventListener(
        "abort",
        () => {
          const message = createAssistantMessage({
            errorMessage: "Interrupted",
            stopReason: "aborted",
          });
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        },
        { once: true },
      );
      return stream;
    };
  }
}

describe("TurnRunner interrupts", () => {
  test("resolves the active turn with the same interrupted terminal event subscribers receive", async () => {
    const runner = new InterruptTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const { turn } = await startTurn(runner, {
      mode: "agent",
      prompt: "Keep working until interrupted.",
    });
    await runner.streamStarted;

    const turnState = events.find((event) => event.type === "turn_started")?.state as
      | TurnState
      | undefined;
    expect(turnState).toBeDefined();
    assert(turnState);

    runner.interrupt({ type: "interrupt" });

    const terminal = await turn;
    const interruptedEvent = events.find((event) => event.type === "interrupted");

    expect(interruptedEvent).toBeDefined();
    assert(interruptedEvent);
    expect(terminal).toBe(interruptedEvent);
    expect(terminal).toMatchObject({
      type: "interrupted",
      state: {
        status: "interrupted",
        agent: { status: "cancelled" },
      },
    });
  });

  test("interrupting a hydrated timer records the state-machine interruption", async () => {
    const runner = new InterruptTurnRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    const now = Date.now();
    const wakeAt = now + 60_000;
    const sleepingState: TurnState = {
      status: "sleeping",
      mode: "agent",
      agent: { status: "waiting", messages: [] },
      stateMachine: {
        definition: {
          name: "hydrated timer",
          prompt: "Wait, then continue.",
          states: [{ name: "wait", kind: "timer", wakeAfterMs: 60_000 }],
        },
        prompt: "",
        currentState: "wait",
        progress: {
          states: {
            wait: { kind: "timer", runs: 1, sleeps: 1, startedAt: now, nextWakeAt: wakeAt },
          },
        },
        history: [
          { type: "state_machine_started", timestamp: now },
          { type: "state_started", timestamp: now, state: "wait" },
        ],
        createdAt: now,
        updatedAt: now,
      },
      tasks: [
        {
          id: "t1",
          kind: "scheduled",
          name: "wait",
          label: "Wait for wait",
          ownerScopeId: "turn-1",
          status: "scheduled",
          startedAt: now,
          wakeAt,
        },
      ],
      nextTaskId: 2,
    };
    await runner.start({ type: "start", state: sleepingState });

    runner.interrupt({ type: "interrupt" });
    await waitFor(() => events.some((event) => event.type === "interrupted"));
    const interrupted = events.find((event) => event.type === "interrupted");
    assert(interrupted?.type === "interrupted");

    expect(interrupted.state).toMatchObject({
      status: "interrupted",
      stateMachine: {
        currentState: "interrupted",
        progress: { states: { wait: { nextWakeAt: undefined } } },
      },
    });
    expect(interrupted.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_interrupted", state: "wait" }),
    );
    expect(interrupted.state.tasks).toContainEqual(
      expect.objectContaining({ id: "t1", status: "stopped" }),
    );
  });
});
