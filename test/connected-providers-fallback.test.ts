import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { waitFor } from "./helpers/async.js";
import { createAssistantMessage } from "./helpers/messages.js";

const previousDuetKey = process.env.DUET_API_KEY;

beforeAll(() => {
  process.env.DUET_API_KEY = "duet_gt_fallback_test";
});

afterAll(() => {
  if (previousDuetKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = previousDuetKey;
});

interface PendingStream {
  model: Model<any>;
  context: Context;
  stream: ReturnType<typeof createAssistantMessageEventStream>;
}

class FallbackRunner extends TurnRunner {
  readonly pending: PendingStream[] = [];
  readonly requests: PendingStream[] = [];

  constructor() {
    super({
      model: "openai-codex:gpt-5.6-sol",
      mode: "agent",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.getApiKey = () => "test-provider-key";
    agent.streamFn = (model, context) => {
      const pending = {
        model,
        context: JSON.parse(JSON.stringify(context)) as Context,
        stream: createAssistantMessageEventStream(),
      };
      this.pending.push(pending);
      this.requests.push(pending);
      return pending.stream;
    };
    return agent;
  }

  failNext(errorMessage: string): void {
    const pending = this.take();
    pending.stream.push({
      type: "error",
      reason: "error",
      error: withTransport(
        createAssistantMessage({ errorMessage, stopReason: "error" }),
        pending.model,
      ),
    });
  }

  completeNextToolCall(name: string, args: Record<string, unknown>): void {
    const pending = this.take();
    pending.stream.push({
      type: "done",
      reason: "toolUse",
      message: withTransport(
        createAssistantMessage({
          extraContent: [{ type: "toolCall", id: "tool_once", name, arguments: args }],
          usage: { input: 10, output: 2 },
        }),
        pending.model,
      ),
    });
  }

  completeNext(text: string): void {
    const pending = this.take();
    pending.stream.push({
      type: "done",
      reason: "stop",
      message: withTransport(
        createAssistantMessage({ text, usage: { input: 10, output: 2 } }),
        pending.model,
      ),
    });
  }

  private take(): PendingStream {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending stream");
    return pending;
  }
}

describe("connected-provider runtime fallback", () => {
  test("emits exactly one system event, reuses the user message, and completes on fallback", async () => {
    const runner = new FallbackRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: "agent" });

    const turn = runner.turn({ type: "prompt", message: "Ship it.", behavior: "follow_up" });
    await waitFor(() => runner.pending.length > 0);
    runner.failNext("429 usage_limit_reached");
    await waitFor(() => runner.pending.length > 0);
    expect(runner.pending[0]!.model.provider).toBe("duet-gateway");
    runner.completeNext("Done.");

    const terminal = await turn;
    const fallbackEvents = events.filter(
      (event) => event.type === "system" && event.message.includes("continuing on"),
    );
    expect(fallbackEvents).toHaveLength(1);
    expect(terminal).toMatchObject({ type: "complete", status: "completed", result: "Done." });
    expect(
      runner.requests[1]!.context.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(JSON.stringify(runner.requests[1]!.context.messages)).toContain("Ship it.");
    await runner.dispose();
  });

  test("does not cross transports or replay a tool effect after streaming has begun", async () => {
    const runner = new FallbackRunner();
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start", mode: "agent" });

    const turn = runner.turn({ type: "prompt", message: "Explain.", behavior: "follow_up" });
    await waitFor(() => runner.pending.length > 0);
    runner.completeNextToolCall("todo_write", {
      merge: false,
      todos: [{ id: "only", content: "only once", status: "in_progress" }],
    });
    await waitFor(() => runner.pending.length > 0);
    runner.failNext("429 usage_limit_reached");
    let terminal: Awaited<typeof turn> | undefined;
    void turn.then((result) => {
      terminal = result;
    });
    await waitFor(() => terminal !== undefined || runner.requests.length > 2);

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: "429 usage_limit_reached",
    });
    expect(runner.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "todos")).toEqual([
      {
        type: "todos",
        todos: [{ id: "only", content: "only once", status: "in_progress" }],
      },
    ]);
    expect(events.filter((event) => event.type === "system")).toHaveLength(0);
    await runner.dispose();
  });
});

function withTransport(message: AssistantMessage, model: Model<any>): AssistantMessage {
  return { ...message, model: model.id, provider: model.provider, api: model.api };
}
