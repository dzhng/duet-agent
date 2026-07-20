import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ClassifierDecision, ClassifierInput } from "../src/model-routing/classifier.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouteClassifier,
} from "../src/model-routing/router.js";
import type { AdvisorPolicy } from "../src/model-routing/table.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { AskAdvisorToolStorage } from "../src/turn-runner/tools.js";
import { settlementNotice } from "../src/turn-runner/task-tools.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineAgentState } from "../src/types/state-machine.js";
import { waitFor } from "./helpers/async.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { testIfDocker } from "./helpers/docker-only.js";

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
  readonly requestMessages: Context["messages"][] = [];
  readonly createdAgentOptions: Array<{ model?: string; thinkingLevel?: string }> = [];
  readonly advisorContextTexts: string[] = [];
  private readonly classify: RouteClassifier;
  private readonly everySteps: number;
  private readonly planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };
  private readonly stepKeywords?: string[];
  private readonly stubAdvisor: boolean;

  constructor(options: {
    classify: RouteClassifier;
    everySteps?: number;
    planTarget?: { modelName: string; thinkingLevel: "low" | "medium" | "high" };
    effectiveContext?: number;
    model?: string;
    cwd?: string;
    stepKeywords?: string[];
    systemInstructions?: string;
    stubAdvisor?: boolean;
  }) {
    super({
      model: options.model ?? "frontier",
      mode: "agent",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
      effectiveContext: options.effectiveContext,
      systemInstructions: options.systemInstructions,
    });
    this.classify = options.classify;
    this.everySteps = options.everySteps ?? 1;
    this.planTarget = options.planTarget;
    this.stepKeywords = options.stepKeywords;
    this.stubAdvisor = options.stubAdvisor ?? false;
  }

  parentAgentForTest(): Agent {
    return this.requireParentAgent();
  }

  emitStateAgentEventForTest(event: AgentEvent): void {
    this.emitAgentEvent(event, { taskId: "t1" });
  }

  emitParentTurnEndForTest(
    message: Extract<AgentMessage, { role: "assistant" }>,
    toolResults: Extract<AgentEvent, { type: "turn_end" }>["toolResults"],
  ): void {
    this.emitParentAgentEvent({ type: "turn_end", message, toolResults });
  }

  createStateAgentForTest(state: StateMachineAgentState) {
    return this.createStateSubagentRun({
      state,
      prompt: state.prompt,
      origin: { taskId: "t1" },
    });
  }

  async transformForTest(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const transform = this.requireParentAgent().transformContext;
    if (!transform) throw new Error("Expected parent context transform");
    return transform(messages);
  }

  seedCompactionHistory(messages: AgentMessage[]): void {
    const state = this.getState();
    if (!state) throw new Error("Expected started runner state");
    const seeded = { ...state, agent: { ...state.agent, messages } };
    this.requireParentAgent().state.messages = messages;
    (this as unknown as { setState: (state: typeof seeded) => void }).setState(seeded);
  }

  protected override createModelRouter(options: ModelRouterOptions): ModelRouter {
    const table = structuredClone(options.table);
    table.classifier.everySteps = this.everySteps;
    if (this.stepKeywords) {
      table.classifier.stepTriggers = [{ name: "test-plumbing", keywords: this.stepKeywords }];
    }
    if (this.planTarget) {
      table.tiers.frontier!.routes.plan!.target = this.planTarget;
    }
    return new ModelRouter({ ...options, table, classify: this.classify });
  }

  protected override async updateMemoryAfterAgentRun(): Promise<void> {
    // Routing tests exercise the parent loop only; durable memory is unrelated.
  }

  protected override createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const storage = super.createAskAdvisorStorage(router, policy);
    if (!this.stubAdvisor) return storage;
    storage.callAdvisor = async (input) => {
      this.advisorContextTexts.push(input.contextText);
      return {
        advice: `Advisor review ${this.advisorContextTexts.length}: inspect the boundary carefully.`,
        usage: {
          inputTokens: 12,
          inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 3,
          outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
          totalTokens: 15,
        },
      };
    };
    return storage;
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
    agent.streamFn = (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      this.requestModels.push(model);
      this.requestMessages.push(structuredClone(context.messages));
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

  failNextWithContextOverflow(): void {
    const pending = this.pendingStreams.shift();
    if (!pending) throw new Error("No pending model stream");
    pending.stream.push({
      type: "error",
      reason: "error",
      error: {
        ...createAssistantMessage({
          errorMessage: "prompt is too long: 2000000 tokens > 1000000 maximum",
          stopReason: "error",
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

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAABGUUKwAAAAi0lEQVR4Ae3VgQ3AIAwEscD+OweJNc7dgNe5OTu7E/5u+O3/6QZQQHwBBOIBjAIUEF8AgXgAfoIIIBBfAIF4AK4AAgjEF0AgHoArgAAC8QUQiAfgCiCAQHwBBOIBuAIIIBBfAIF4AK4AAgjEF0AgHoArgAAC8QUQiAfgCiCAQHwBBOIBuAIIIBBf4AFTuAN9D/8DSwAAAABJRU5ErkJggg==";

describe("TurnRunner virtual-model adapter", () => {
  test("task plumbing is routing-neutral while genuine assistant text still arms a trigger", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stepKeywords: ["SETTLEMENT_TRIGGER_Q7"],
      classify: scriptedClassifier([{ route: "general", rationale: "Initial route." }]),
    });
    await startRunner(runner, []);
    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "ordinary", usageTokens: 5 });
    await first;

    const plumbing = settlementNotice([
      {
        descriptor: {
          id: "t1",
          kind: "tool",
          name: "bash",
          label: "SETTLEMENT_TRIGGER_Q7",
          ownerScopeId: "turn-1",
          status: "completed",
          startedAt: 1,
        },
        output: [],
        settlement: { id: "t1", status: "completed", settledAt: 2, result: "done" },
      },
    ]);
    runner.emitParentTurnEndForTest(createAssistantMessage({ text: "ordinary" }), [
      {
        role: "toolResult",
        toolCallId: "settlement-test",
        toolName: "bash",
        content: [{ type: "text", text: plumbing }],
        details: undefined,
        isError: false,
        timestamp: 2,
      },
    ]);
    expect(runner.routeStatus()?.stepsUntilClassification).toBeGreaterThan(0);

    runner.emitParentTurnEndForTest(
      createAssistantMessage({ text: "Genuine SETTLEMENT_TRIGGER_Q7 analysis." }),
      [],
    );
    expect(runner.routeStatus()?.stepsUntilClassification).toBe(0);
    await runner.dispose();
  });

  testIfDocker("a concrete-started session can switch to a project-only virtual tier", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-concrete-"));
    try {
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.defaultTier = "custom";
      table.tiers = { custom: table.tiers.economy! };
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new RouterTurnRunner({
        model: "gpt-5.6-sol",
        cwd,
        classify: scriptedClassifier([]),
      });
      await startRunner(runner, []);

      expect(runner.setModel("custom")).toEqual({ routed: true });
      expect(runner.routeStatus()?.tier).toBe("custom");
      expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-5.6-luna");
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("concrete pin suspends routing and virtual selection rebuilds it for re-classification", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "plan", rationale: "Fresh routed turn." }]),
    });
    await startRunner(runner, []);

    expect(runner.setModel("gpt-5.6-luna")).toEqual({ routed: false });
    expect(runner.routeStatus()?.pinned).toBe(true);
    expect(runner.parentAgentForTest().state.model.id).toBe("openai/gpt-5.6-luna");

    expect(runner.setModel("frontier")).toEqual({ routed: true });
    expect(runner.routeStatus()?.pinned).toBe(false);
    expect(runner.routeStatus()?.stepsUntilClassification).toBe(0);

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
      visionFallback: false,
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
    expect(runner.requestMessages).toHaveLength(2);
    expect(JSON.stringify(runner.requestMessages[1])).toBe(
      JSON.stringify(terminal.state.agent.messages.slice(0, -1)),
    );
    expect(runner.requestMessages[1]!.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(runner.requestMessages[1]![0])).toContain("Plan, then implement.");
    expect(terminal.state.wireGuardHorizon?.evictionHorizon ?? 0).toBe(0);
  });

  test("explicit compaction arms one classification without a second switch-only compaction", async () => {
    const inputs: ClassifierInput[] = [];
    const decisions = [
      { route: "general", rationale: "Start general work." },
      { route: "plan", rationale: "Reconsider after compaction." },
    ];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      effectiveContext: 1_000,
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classification feedback loop");
        return decision;
      },
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Started.", usageTokens: 5 });
    await first;

    runner.seedCompactionHistory(
      Array.from({ length: 12 }, (_unused, index) => ({
        role: "user" as const,
        content: `history-${index} ${"x".repeat(1_000)}`,
        timestamp: index + 1,
      })),
    );
    await runner.compact();

    const second = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Continued.", usageTokens: 5 });
    await second;

    const third = runner.turn({
      type: "prompt",
      message: "Continue again.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Still continuing.", usageTokens: 5 });
    await third;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(events.filter((event) => event.type === "router_switch")).toEqual([
      expect.objectContaining({
        trigger: "compaction",
        fromModel: "gpt-5.6-sol",
        toModel: "fable-5",
      }),
    ]);
    expect(
      events.filter((event) => event.type === "system" && event.message.startsWith("compact:"))
        .length,
    ).toBe(1);
  });

  test("memory-budget compaction arms classification at the next boundary", async () => {
    const inputs: ClassifierInput[] = [];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      effectiveContext: 100,
      classify: async (input) => {
        inputs.push(input);
        return { route: "general", rationale: "Keep the target unchanged." };
      },
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const first = runner.turn({ type: "prompt", message: "Begin.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Started.", usageTokens: 5 });
    await first;

    await runner.transformForTest([
      { role: "user", content: "x".repeat(1_000), timestamp: 1 },
      { role: "user", content: "latest", timestamp: 2 },
    ]);
    const second = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Continued.", usageTokens: 5 });
    await second;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(events.filter((event) => event.type === "router_switch")).toEqual([]);
    expect(
      events.filter((event) => event.type === "system" && event.message.startsWith("compact:")),
    ).toEqual([]);
  });

  test("context-overflow recovery classifies once without forcing an extra model turn", async () => {
    const inputs: ClassifierInput[] = [];
    const decisions = [
      { route: "general", rationale: "Start general work." },
      { route: "plan", rationale: "Use a fresh target after overflow compaction." },
    ];
    const runner = new RouterTurnRunner({
      everySteps: 99,
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classification feedback loop");
        return decision;
      },
    });
    await startRunner(runner, []);
    runner.seedCompactionHistory([
      { role: "user", content: "one", timestamp: 1 },
      createAssistantMessage({ text: "two", timestamp: 2 }),
      { role: "user", content: "three", timestamp: 3 },
      createAssistantMessage({ text: "four", timestamp: 4 }),
    ]);

    const turn = runner.turn({ type: "prompt", message: "Continue.", behavior: "follow_up" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.failNextWithContextOverflow();
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Recovered.", usageTokens: 5 });
    await turn;

    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "compaction"]);
    expect(runner.requestModels).toHaveLength(2);
    expect(runner.parentAgentForTest().state.model.api).toBe("anthropic-messages");
  });

  testIfDocker("an image tool result triggers the vision guard at the next boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-image-step-"));
    try {
      await writeFile(join(cwd, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      const runner = new RouterTurnRunner({
        model: "economy",
        cwd,
        everySteps: 99,
        classify: scriptedClassifier([
          { route: "implement", rationale: "The prompt requests file implementation." },
          { route: "implement", rationale: "Continue the implementation task." },
        ]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Read shot.png, then report what you found.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.requestModels.at(-1)?.id).toBe("zai/glm-5.2");
      runner.completeNext({
        tool: { name: "read", arguments: { path: "shot.png" } },
        usageTokens: 5,
      });

      await waitFor(() => runner.pendingStreams.length === 1);
      expect(runner.routeStatus()?.facts).toEqual({ hasImages: true });
      expect(runner.requestModels.at(-1)?.id).toBe("openai/gpt-5.6-luna");
      runner.completeNext({ text: "The image was read.", usageTokens: 5 });
      await turn;

      expect(events.filter((event) => event.type === "router_switch").at(-1)).toMatchObject({
        trigger: "step_trigger",
        route: "implement",
        fromModel: "glm-5.2",
        toModel: "gpt-5.6-luna",
        visionFallback: true,
      });
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  testIfDocker("configured keyword output forces step-trigger classification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-keyword-step-"));
    try {
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.classifier.stepTriggers = [{ name: "escalate", keywords: ["ESCALATE_ROUTE"] }];
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
      const runner = new RouterTurnRunner({
        cwd,
        everySteps: 99,
        classify: scriptedClassifier([
          { route: "general", rationale: "Start general work." },
          { route: "plan", rationale: "Escalate after the tool result." },
        ]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Run the requested check.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "printf ESCALATE_ROUTE" } },
        usageTokens: 5,
      });

      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Escalated.", usageTokens: 5 });
      await turn;

      expect(events.filter((event) => event.type === "router_switch").at(-1)).toMatchObject({
        trigger: "step_trigger",
        route: "plan",
      });
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  testIfDocker("a concrete session ignores image step routing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-router-concrete-image-"));
    try {
      await writeFile(join(cwd, "shot.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      const runner = new RouterTurnRunner({
        model: "gpt-5.6-luna",
        cwd,
        classify: scriptedClassifier([]),
      });
      const events: TurnEvent[] = [];
      await startRunner(runner, events);

      const turn = runner.turn({
        type: "prompt",
        message: "Read shot.png.",
        behavior: "follow_up",
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "read", arguments: { path: "shot.png" } },
        usageTokens: 5,
      });
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({ text: "Done.", usageTokens: 5 });
      await turn;

      expect(runner.routeStatus()).toBeUndefined();
      expect(events.filter((event) => event.type === "router_switch")).toEqual([]);
      await runner.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("state-agent assistant events do not tick the parent router", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([{ route: "general", rationale: "General." }]),
    });
    await startRunner(runner, []);
    const message = createAssistantMessage({ text: "child result" });

    runner.emitStateAgentEventForTest({ type: "message_end", message });
    expect(runner.routeStatus()?.assistantSteps).toBe(0);
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
    expect(runner.routeStatus()?.modelName).toBe("fable-5");
    expect(runner.parentAgentForTest().state.model.id).toBe(runner.requestModels[0]!.id);
    expect(events.filter((event) => event.type === "router_switch")).toHaveLength(1);
  });

  test("memory transform re-reads the smaller routed context window", async () => {
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([
        { route: "general", rationale: "Stay on the large model." },
        { route: "plan", rationale: "Move to the smaller model." },
      ]),
      // haiku-4.5's real 200k window is the smallest in the catalog — luna
      // previously served this role only because its synthesized spec
      // under-reported 256k; its true window is 1.05M.
      planTarget: { modelName: "haiku-4.5", thinkingLevel: "low" },
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
    expect(runner.parentAgentForTest().state.model.id).toBe("anthropic/claude-haiku-4.5");
    expect((await runner.transformForTest(largeTail)).length).toBeLessThan(3);
    runner.completeNext({ text: "Done.", usageTokens: 5 });
    await turn;
  });
});

describe("advisor executor guidance layer", () => {
  test("completion review resets a recent orientation consultation's cooldown", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stubAdvisor: true,
      classify: async () => ({ route: "general", rationale: "Keep the executor stable." }),
    });
    const events: TurnEvent[] = [];
    await startRunner(runner, events);

    const turn = runner.turn({
      type: "prompt",
      message: "Implement the durable queue migration.",
      behavior: "follow_up",
    });
    for (let step = 0; step < 3; step++) {
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
    }

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("orientation checkpoint");
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 1);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 5,
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.routeStatus()?.advisorGate.allowed).toBe(false);
    expect(runner.routeStatus()?.advisorGate.stepsUntilAllowed).toBeGreaterThan(0);
    runner.completeNext({ text: "The migration is implemented.", usageTokens: 5 });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.routeStatus()?.advisorGate).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    const completionRequest = JSON.stringify(runner.requestMessages.at(-1));
    expect(completionRequest).toContain("completion-review checkpoint");
    expect(completionRequest).toContain("Implement the durable queue migration.");
    expect(completionRequest).toContain("Advisor review 1");
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 2);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Migration complete and reviewed.", usageTokens: 5 });

    const terminal = await turn;
    expect(terminal.type).toBe("complete");
    if (terminal.type !== "complete") throw new Error(`Unexpected terminal: ${terminal.type}`);
    expect(terminal.result).toBe("Migration complete and reviewed.");
    expect(runner.advisorContextTexts[1]).toContain("The migration is implemented.");
    expect(runner.advisorContextTexts[1]).toContain("completion-review checkpoint");
    expect(
      events.filter(
        (event) =>
          event.type === "step" &&
          event.step.type === "tool_call_start" &&
          event.step.toolName === "ask_advisor",
      ),
    ).toHaveLength(2);
    await runner.dispose();
  });

  test("a third-step final response consumes the orientation steer before the pass stops", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stubAdvisor: true,
      classify: async () => ({ route: "general", rationale: "Keep the executor stable." }),
    });
    await startRunner(runner, []);

    const turn = runner.turn({
      type: "prompt",
      message: "Investigate the migration and finish after the evidence is clear.",
      behavior: "follow_up",
    });
    for (let step = 0; step < 2; step++) {
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
    }
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "The evidence looks complete.", usageTokens: 5 });

    await waitFor(() => runner.pendingStreams.length === 1);
    expect(JSON.stringify(runner.requestMessages.at(-1))).toContain("orientation checkpoint");
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 1);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Evidence reviewed; migration complete.", usageTokens: 5 });

    const terminal = await turn;
    expect(terminal.type).toBe("complete");
    expect(runner.advisorContextTexts).toHaveLength(1);
    expect(JSON.stringify(terminal.state.agent.messages)).not.toContain(
      "completion-review checkpoint",
    );
    await runner.dispose();
  });

  test("a voluntary final-evidence consultation does not trigger an immediate duplicate", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stubAdvisor: true,
      classify: async () => ({ route: "general", rationale: "Keep the executor stable." }),
    });
    await startRunner(runner, []);

    const turn = runner.turn({
      type: "prompt",
      message: "Inspect the evidence, obtain strategic review when ready, and finish.",
      behavior: "follow_up",
    });
    for (let step = 0; step < 2; step++) {
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext({
        tool: { name: "bash", arguments: { command: "true" } },
        usageTokens: 5,
      });
    }
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ tool: { name: "ask_advisor", arguments: {} }, usageTokens: 5 });
    await waitFor(() => runner.advisorContextTexts.length === 1);
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Reviewed and complete.", usageTokens: 5 });

    const terminal = await turn;
    expect(terminal.type).toBe("complete");
    expect(runner.advisorContextTexts).toHaveLength(1);
    const transcript = JSON.stringify(terminal.state.agent.messages);
    expect(transcript).not.toContain("orientation checkpoint");
    expect(transcript).not.toContain("completion-review checkpoint");
    await runner.dispose();
  });

  test("routine agent work finishes without lifecycle consultation checkpoints", async () => {
    const runner = new RouterTurnRunner({
      everySteps: 99,
      stubAdvisor: true,
      classify: async () => ({ route: "general", rationale: "Keep the executor stable." }),
    });
    await startRunner(runner, []);

    const turn = runner.turn({
      type: "prompt",
      message: "Read one value and answer.",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({
      tool: { name: "bash", arguments: { command: "true" } },
      usageTokens: 5,
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext({ text: "Done.", usageTokens: 5 });

    const terminal = await turn;
    expect(terminal.type).toBe("complete");
    expect(runner.advisorContextTexts).toEqual([]);
    expect(JSON.stringify(terminal.state.agent.messages)).not.toContain("checkpoint");
    expect(runner.requestMessages).toHaveLength(2);
    await runner.dispose();
  });

  testIfDocker("routed tiers with the advisor enabled carry the timing layer", async () => {
    const frontier = new RouterTurnRunner({ classify: scriptedClassifier([]) });
    await startRunner(frontier, []);
    expect(frontier.parentAgentForTest().state.systemPrompt).toContain(
      "For tasks longer than a few steps, consult at least once",
    );
    await frontier.dispose();

    const economy = new RouterTurnRunner({ model: "economy", classify: scriptedClassifier([]) });
    await startRunner(economy, []);
    expect(economy.parentAgentForTest().state.systemPrompt).not.toContain(
      "For tasks longer than a few steps, consult at least once",
    );
    await economy.dispose();

    const concrete = new RouterTurnRunner({
      model: "gpt-5.6-sol",
      classify: scriptedClassifier([]),
    });
    await startRunner(concrete, []);
    expect(concrete.parentAgentForTest().state.systemPrompt).not.toContain(
      "For tasks longer than a few steps, consult at least once",
    );
    await concrete.dispose();
  });

  testIfDocker("advisor guidance retains an unrelated workflow rule", async () => {
    const workflowRule = "WORKFLOW-USES-BOUNDED-VALIDATION";
    const runner = new RouterTurnRunner({
      classify: scriptedClassifier([]),
      systemInstructions: workflowRule,
    });
    await startRunner(runner, []);

    const systemPrompt = runner.parentAgentForTest().state.systemPrompt;
    expect(systemPrompt).toContain(workflowRule);
    expect(systemPrompt).toContain("Skip consultation for routine, local,");
    expect(systemPrompt).not.toContain("Follow any stricter workflow-specific system instruction");
    await runner.dispose();
  });
});
