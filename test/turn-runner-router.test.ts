import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ClassifierDecision } from "../src/model-routing/classifier.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouteClassifier,
} from "../src/model-routing/router.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import { waitFor } from "./helpers/async.js";
import { createAssistantMessage } from "./helpers/messages.js";

const previousDuetApiKey = process.env.DUET_API_KEY;

beforeAll(() => {
  process.env.DUET_API_KEY = "router-test-key";
});

afterAll(() => {
  if (previousDuetApiKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = previousDuetApiKey;
});

interface PendingStream {
  model: Model<any>;
  stream: ReturnType<typeof createAssistantMessageEventStream>;
}

class RouterTurnRunner extends TurnRunner {
  readonly pendingStreams: PendingStream[] = [];
  readonly requestModels: Model<any>[] = [];
  readonly createdAgentOptions: Array<{ model?: string; thinkingLevel?: string }> = [];
  private readonly classify: RouteClassifier;
  private readonly everySteps: number;
  private readonly planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };

  constructor(options: {
    classify: RouteClassifier;
    everySteps?: number;
    planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };
    effectiveContext?: number;
  }) {
    super({
      model: "frontier",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
      effectiveContext: options.effectiveContext,
    });
    this.classify = options.classify;
    this.everySteps = options.everySteps ?? 1;
    this.planTarget = options.planTarget;
  }

  routerStatusForTest() {
    return this.modelRouter?.status();
  }

  parentAgentForTest(): Agent {
    return this.requireParentAgent();
  }

  emitStateAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event, { kind: "state_machine_agent", state: "child" });
  }

  createStateAgentForTest(state: StateMachineAgentState) {
    return this.createStateAgentHandle({ state, prompt: state.prompt });
  }

  async transformForTest(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const transform = this.requireParentAgent().transformContext;
    if (!transform) throw new Error("Expected parent context transform");
    return transform(messages);
  }

  protected override createModelRouter(options: ModelRouterOptions): ModelRouter {
    const table = structuredClone(options.table);
    table.classifier.everySteps = this.everySteps;
    if (this.planTarget) {
      table.tiers.frontier!.routes.plan!.target = this.planTarget;
    }
    return new ModelRouter({ ...options, table, classify: this.classify });
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    // Routing tests exercise the parent loop only; durable memory is unrelated.
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    this.createdAgentOptions.push({
      model: input.state.options?.model,
      thinkingLevel: input.state.options?.thinkingLevel,
    });
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      this.requestModels.push(model);
      this.pendingStreams.push({ model, stream });
      if (options?.signal?.aborted) {
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              ...createAssistantMessage({ errorMessage: "aborted", stopReason: "aborted" }),
              model: model.id,
              provider: model.provider,
              api: model.api,
            },
          });
        });
      }
      return stream;
    };
    return agent;
  }

  completeNext(input: {
    text?: string;
    tool?: { name: string; arguments: Record<string, unknown> };
    usageTokens: number;
    thinking?: string;
  }): void {
    const pending = this.pendingStreams.shift();
    if (!pending) throw new Error("No pending model stream");
    const extraContent: AssistantMessage["content"] = [
      ...(input.thinking
        ? [{ type: "thinking" as const, thinking: input.thinking, thinkingSignature: "sig" }]
        : []),
      ...(input.tool
        ? [
            {
              type: "toolCall" as const,
              id: `tool_${Date.now()}`,
              name: input.tool.name,
              arguments: input.tool.arguments,
            },
          ]
        : []),
    ];
    pending.stream.push({
      type: "done",
      reason: input.tool ? "toolUse" : "stop",
      message: {
        ...createAssistantMessage({
          text: input.text,
          extraContent,
          usage: { input: input.usageTokens - 1, output: 1 },
        }),
        model: pending.model.id,
        provider: pending.model.provider,
        api: pending.model.api,
      },
    });
  }
}

function scriptedClassifier(decisions: ClassifierDecision[]): RouteClassifier {
  return async () => {
    const decision = decisions.shift();
    if (!decision) throw new Error("No scripted route decision");
    return decision;
  };
}

async function startRunner(runner: RouterTurnRunner, events: TurnEvent[]): Promise<void> {
  runner.subscribe((event) => events.push(event));
  await runner.start({ type: "start", mode: "agent" });
}

describe("TurnRunner virtual-model adapter", () => {
  test("concrete pin suspends routing and virtual selection rebuilds it for re-classification", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "plan", rationale: "Fresh routed turn." }]),
    });
    await startRunner(runner, []);

    expect(runner.setModel("gpt-5.6-luna")).toEqual({ routed: false });
    expect(runner.routerStatusForTest()?.pinned).toBe(true);
    expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-5.6-luna");

    expect(runner.setModel("frontier")).toEqual({ routed: true });
    expect(runner.routerStatusForTest()?.pinned).toBe(false);
    expect(runner.routerStatusForTest()?.stepsUntilClassification).toBe(0);

    const turn = runner.turn({ type: "prompt", message: "Plan this.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels.at(-1)?.api).toBe("anthropic-messages");
    runner.completeNext({ text: "Planned.", usageTokens: 5 });
    const terminal = await turn;
    expect(terminal.state.options?.model).toBe("frontier");
  });

  test("explicit virtual state model resolves its tier default while omission still inherits", async () => {
    const runner = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(runner, []);

    runner.createStateAgentForTest({
      kind: "agent",
      name: "economy-child",
      prompt: "Do the child task.",
      model: "economy",
      thinkingLevel: "high",
    });
    expect(runner.createdAgentOptions.at(-1)).toEqual({
      model: "gpt-5.6-luna",
      thinkingLevel: "low",
    });

    runner.createStateAgentForTest({
      kind: "agent",
      name: "inherited-child",
      prompt: "Do the inherited task.",
    });
    expect(runner.createdAgentOptions.at(-1)?.model).toContain("openai/gpt-5.6-sol");
    expect(runner.createdAgentOptions.at(-1)?.thinkingLevel).toBe("medium");
  });

  test("resumed routed selection re-classifies instead of restoring a concrete target", async () => {
    const original = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(original, []);
    const saved = structuredClone(original.getState()!);
    expect(saved.options?.model).toBe("frontier");

    const resumed = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "plan", rationale: "Classify the resumed prompt." }]),
    });
    await resumed.start({ type: "start", state: saved });
    const turn = resumed.turn({
      type: "prompt",
      message: "Continue planning.",
      behavior: "follow_up",
    });
    await waitFor(() => resumed.pendingStreams.length === 1);
    expect(resumed.requestModels[0]!.api).toBe("anthropic-messages");
    resumed.completeNext({ text: "Continued.", usageTokens: 5 });
    const terminal = await turn;
    expect(terminal.state.options?.model).toBe("frontier");
  });

  test("mid-turn cross-family swap emits router_switch and attributes usage per message model", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([
        { route: "plan", rationale: "Start with architecture." },
        { route: "implement", rationale: "The plan is ready to implement." },
      ]),
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const turn = runner.turn({
      type: "prompt",
      message: "Plan, then implement.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels[0]!.api).toBe("anthropic-messages");
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 10,
      thinking: "The architecture is settled.",
    });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.requestModels[1]!.api).toBe("openai-responses");
    runner.completeNext({ text: "Implemented.", usageTokens: 20 });
    const terminal = await turn;

    const switches = events.filter((event) => event.type === "router_switch");
    expect(switches.at(-1)).toEqual({
      type: "router_switch",
      tier: "frontier",
      route: "implement",
      fromModel: "fable-5",
      toModel: "gpt-5.6-sol",
      thinkingLevel: "high",
      trigger: "cadence",
      rationale: "The plan is ready to implement.",
    });
    expect(terminal.turnUsage?.totalTokens).toBe(30);
    expect(terminal.usageByModel).toEqual([
      expect.objectContaining({
        model: runner.requestModels[0]!.id,
        usage: expect.objectContaining({ totalTokens: 10 }),
      }),
      expect.objectContaining({
        model: runner.requestModels[1]!.id,
        usage: expect.objectContaining({ totalTokens: 20 }),
      }),
    ]);
    expect(
      terminal.usageByModel?.reduce((total, entry) => total + entry.usage.totalTokens, 0),
    ).toBe(terminal.turnUsage?.totalTokens);
    expect(terminal.state.options?.model).toBe("frontier");
    const injectedNudges = terminal.state.agent.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
      )
      .filter((text) => text.includes("The routed model changed"));
    expect(injectedNudges).toContainEqual(
      expect.stringContaining("changed from fable-5 to gpt-5.6-sol for the implement route"),
    );
  });

  test("state-agent assistant events do not tick the parent router", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "general", rationale: "General." }]),
    });
    await startRunner(runner, []);
    const message = createAssistantMessage({ text: "child result" });

    runner.emitStateAgentEventForTest({ type: "message_end", message });
    expect(runner.routerStatusForTest()?.assistantSteps).toBe(0);
  });

  test("interrupting an in-flight classifier keeps the routed model unchanged", async () => {
    let classificationStarted = false;
    let calls = 0;
    const classify: RouteClassifier = async (_input, signal) => {
      calls += 1;
      if (calls === 1) return { route: "plan", rationale: "Start on the plan model." };
      classificationStarted = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const runner = new RouterTurnRunner({ classify });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const turn = runner.turn({
      type: "prompt",
      message: "Work until interrupted.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 5,
    });
    await waitFor(() => classificationStarted);
    runner.interrupt({ type: "interrupt" });
    const terminal = await turn;

    expect(terminal.type).toBe("interrupted");
    expect(runner.routerStatusForTest()?.modelName).toBe("fable-5");
    expect(runner.parentAgentForTest().state.model.id).toBe(runner.requestModels[0]!.id);
    expect(events.filter((event) => event.type === "router_switch")).toHaveLength(1);
  });

  test("memory transform re-reads the smaller routed context window", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([
        { route: "general", rationale: "Stay on the large model." },
        { route: "plan", rationale: "Move to the smaller model." },
      ]),
      planTarget: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
      effectiveContext: 2_000_000,
    });
    await startRunner(runner, []);
    const largeTail: AgentMessage[] = [
      { role: "user", content: "a".repeat(350_000), timestamp: 1 },
      createAssistantMessage({ text: "b".repeat(300_000), timestamp: 2 }),
      { role: "user", content: "c".repeat(50_000), timestamp: 3 },
    ];
    expect(await runner.transformForTest(largeTail)).toHaveLength(3);

    const turn = runner.turn({ type: "prompt", message: "Change phase.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 5,
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-5.6-luna");
    expect((await runner.transformForTest(largeTail)).length).toBeLessThan(3);
    runner.completeNext({ text: "Done.", usageTokens: 5 });
    await turn;
  });
});
