import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { TurnRunner, type AgentWorkerInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";

function createAbortedMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Interrupted",
    timestamp: Date.now(),
  };
}

class InterruptTurnRunner extends TurnRunner {
  streamStarted: Promise<void>;
  private resolveStreamStarted!: () => void;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-6",
      skillDiscovery: { includeDefaults: false },
    });
    this.streamStarted = new Promise((resolve) => {
      this.resolveStreamStarted = resolve;
    });
  }

  protected override createAgent(input: AgentWorkerInput): Agent {
    return new Agent({
      initialState: {
        model: { provider: "unknown", id: "test" } as never,
        thinkingLevel: input.options?.thinkingLevel ?? "medium",
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
          const message = createAbortedMessage();
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

    const turn = runner.turn({
      type: "start",
      mode: "agent",
      prompt: "Keep working until interrupted.",
    });
    await runner.streamStarted;

    const turnState = events.find((event) => event.type === "session_started")?.state as
      | TurnState
      | undefined;
    expect(turnState).toBeDefined();
    assert(turnState);

    runner.interrupt({ type: "interrupt", state: turnState });

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
});
