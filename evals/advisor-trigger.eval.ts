import { describe, expect } from "bun:test";
import { bestOfAttempts } from "../test/helpers/best-of.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierInput } from "../src/model-routing/classifier.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouteClassifier,
} from "../src/model-routing/router.js";
import { createAskAdvisorTool } from "../src/turn-runner/tools.js";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnUsageEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";

const executorModel = process.env.EVAL_MODEL ?? "sonnet-4.6";

interface CapturedToolCall {
  name: string;
  output?: string;
}

class CapturingRunner extends TurnRunner {
  readonly classifierInputs: ClassifierInput[] = [];

  constructor(model: "frontier" | "economy", systemInstructions?: string) {
    super({
      model,
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
      systemInstructions,
    });
  }

  toolNames(): string[] {
    return this.requireParentAgent().state.tools.map((tool) => tool.name);
  }

  systemPrompt(): string {
    return this.requireParentAgent().state.systemPrompt;
  }

  protected override createModelRouter(options: ModelRouterOptions): ModelRouter {
    const table = structuredClone(options.table);
    if (options.tier === "frontier") {
      for (const rule of Object.values(table.tiers.frontier!.routes)) {
        rule.target.modelName = executorModel;
      }
    }
    const classify: RouteClassifier = async (input, signal) => {
      this.classifierInputs.push(structuredClone(input));
      return options.classify(input, signal);
    };
    return new ModelRouter({ ...options, table, classify });
  }
}

class NudgeRunner extends TurnRunner {
  router?: ModelRouter;

  constructor() {
    super({
      model: "frontier",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override createModelRouter(options: ModelRouterOptions): ModelRouter {
    const classify: RouteClassifier = async () => ({
      route: "plan",
      rationale: "The task moved into architectural planning.",
    });
    this.router = new ModelRouter({ ...options, classify });
    return this.router;
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            ...createAssistantMessage({ text: "Acknowledged.", usage: { input: 1, output: 1 } }),
            model: model.id,
            provider: model.provider,
            api: model.api,
          },
        });
      });
      return stream;
    };
    return agent;
  }
}

/**
 * Calls the real auxiliary models without asking an executor to choose whether
 * to consult. The synthetic parent snapshot stands in for an already-completed
 * parent call so this eval can inspect the production streaming event without
 * paying for an unrelated third model request.
 */
class LiveAuxiliaryUsageRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      model: "swebench-glm-kimi",
      mode: "agent",
      cwd,
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  installParentSnapshot(): void {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    this.lastParentUsageSnapshot = {
      lastMessageUsage: usage,
      effectiveContextWindow: 200_000,
      contextWindowUsage: { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 },
    };
  }

  classifySpawn() {
    return this.selectSpawnModel("Implement the migration safely.", "swebench-glm-kimi");
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }

  addUserMessage(): void {
    this.requireParentAgent().state.messages.push({
      role: "user",
      content: "Review the migration plan and identify its highest-risk assumption.",
      timestamp: Date.now(),
    });
  }
}

function captureToolCalls(runner: TurnRunner): CapturedToolCall[] {
  const calls: CapturedToolCall[] = [];
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    const step = event.step;
    if (step.type === "tool_call_start") {
      calls.push({ name: step.toolName });
      return;
    }
    if (step.type !== "tool_call" || step.toolName !== "ask_advisor") return;
    const call = [...calls].reverse().find((candidate) => candidate.name === step.toolName);
    if (!call) return;
    call.output = step.output
      ?.filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
  });
  return calls;
}

describe("advisor trigger and router interlock", () => {
  testIfDocker(
    "real classifier and advisor calls share one cumulative per-model ledger",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-live-auxiliary-usage-"));
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      const advisor = structuredClone(table.tiers.frontier!.advisor);
      advisor.target = { modelName: "kimi-k3", thinkingLevel: "high" };
      table.defaultTier = "swebench-glm-kimi";
      table.tiers = {
        "swebench-glm-kimi": {
          routes: {
            general: {
              description: "SWE-bench software implementation and debugging.",
              target: { modelName: "glm-5.2", thinkingLevel: "high" },
              visionFallbackModelName: "kimi-k3",
            },
          },
          advisor,
        },
      };
      await mkdir(join(workDir, ".duet"));
      await writeFile(join(workDir, ".duet", "models.json"), JSON.stringify(table));

      const runner = new LiveAuxiliaryUsageRunner(workDir);
      const usageEvents: TurnUsageEvent[] = [];
      runner.subscribe((event) => {
        if (event.type === "usage") usageEvents.push(event);
      });

      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.installParentSnapshot();
        await runner.classifySpawn();
        runner.addUserMessage();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");
        await advisor.execute("live-auxiliary-accounting", {});

        const usage = usageEvents.at(-1);
        const classifierId = resolveModelName(
          BUILT_IN_ROUTING_TABLE.classifier.target.modelName,
        ).id;
        const advisorId = resolveModelName(
          table.tiers["swebench-glm-kimi"]!.advisor.target.modelName,
        ).id;
        expect(
          usage?.usageByModel.find((entry) => entry.model === classifierId)?.usage.totalTokens ?? 0,
        ).toBeGreaterThan(0);
        expect(
          usage?.usageByModel.find((entry) => entry.model === advisorId)?.usage.totalTokens ?? 0,
        ).toBeGreaterThan(0);
        expect(usage?.usageByModel.reduce((sum, entry) => sum + entry.usage.totalTokens, 0)).toBe(
          usage?.turnUsage.totalTokens,
        );
        expect(
          usage?.usageByModel.reduce((sum, entry) => sum + entry.usage.cost.total, 0),
        ).toBeCloseTo(usage?.turnUsage.cost.total ?? 0, 9);
      } finally {
        await runner.dispose();
        await rm(workDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  testIfDocker(
    "challenging underspecified architecture work consults the advisor and reclassifies",
    async () => {
      // Live consult rate on this fixture is noisy (~50% observed pre-layer);
      // the restraint case below stays single-run strict — its failure mode is
      // over-calling, and retries would mask that.
      await bestOfAttempts(2, async () => {
        const runner = new CapturingRunner(
          "frontier",
          dedent`
            This is a bounded architecture evaluation. Do not inspect or modify files and do not run
            commands. Decide how to approach the request. State the first design decision you would
            validate, then stop.
          `,
        );
        const toolCalls = captureToolCalls(runner);
        const usageEvents: TurnUsageEvent[] = [];
        runner.subscribe((event) => {
          if (event.type === "usage") usageEvents.push(event);
        });

        const { turn } = await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
            Design a no-downtime migration of a mature multi-tenant TypeScript agent runner from
            in-process scheduling and local SQLite memory to horizontally scaled durable execution.
            External side effects must be exactly-once, sessions must resume after regional failover
            within 30 seconds, and existing third-party plugins cannot change. We have not chosen a
            queue, database, lease model, or ownership boundary. Before writing code, recommend the
            architecture and the first safe implementation slice.
          `,
        });
        try {
          const terminal = await turn;
          const advisorCalls = toolCalls.filter((call) => call.name === "ask_advisor");

          expect(terminal.type).toBe("complete");
          expect(advisorCalls).toHaveLength(1);
          expect(advisorCalls[0]?.output?.length).toBeGreaterThan(0);
          expect(runner.classifierInputs.map((input) => input.trigger)).toContain("advisor");

          const classifierId = resolveModelName(
            BUILT_IN_ROUTING_TABLE.classifier.target.modelName,
          ).id;
          const advisorId = resolveModelName(
            BUILT_IN_ROUTING_TABLE.tiers.frontier!.advisor.target.modelName,
          ).id;
          const usageByModel = terminal.usageByModel ?? [];
          expect(
            usageByModel.find((entry) => entry.model === classifierId)?.usage.totalTokens ?? 0,
          ).toBeGreaterThan(0);
          expect(
            usageByModel.find((entry) => entry.model === advisorId)?.usage.totalTokens ?? 0,
          ).toBeGreaterThan(0);
          expect(terminal.turnUsage).toBeDefined();
          expect(usageByModel.reduce((sum, entry) => sum + entry.usage.totalTokens, 0)).toBe(
            terminal.turnUsage!.totalTokens,
          );
          expect(usageByModel.reduce((sum, entry) => sum + entry.usage.cost.total, 0)).toBeCloseTo(
            terminal.turnUsage!.cost.total,
            9,
          );
          const lastUsage = usageEvents.at(-1);
          expect(lastUsage?.turnUsage).toEqual(terminal.turnUsage);
          expect(lastUsage?.usageByModel).toEqual(usageByModel);
        } finally {
          await runner.dispose();
        }
      });
    },
    360_000,
  );

  testIfDocker(
    "routine local work does not consult the advisor",
    async () => {
      const runner = new CapturingRunner(
        "frontier",
        dedent`
          This is a bounded evaluation. Do not inspect or modify files and do not run commands.
          Answer the user's small local question directly, then stop.
        `,
      );
      const toolCalls = captureToolCalls(runner);

      const { turn } = await startTurn(runner, {
        mode: "agent",
        prompt:
          "In src/labels.ts, rename the local variable tmp to normalizedLabel. Just state the obvious rename in one sentence; do not inspect or edit the file.",
      });
      const terminal = await turn;

      expect(terminal.type).toBe("complete");
      expect(toolCalls.filter((call) => call.name === "ask_advisor")).toHaveLength(0);
      await runner.dispose();
    },
    120_000,
  );

  testIfDocker(
    "workflow-specific advisor precedence reaches the executor prompt",
    async () => {
      const workflowRule = "WORKFLOW-REQUIRES-ADVISOR-EVEN-WHEN-ROUTINE";
      const runner = new CapturingRunner("frontier", workflowRule);
      await runner.start({ type: "start", mode: "agent" });

      expect(runner.systemPrompt()).toContain(workflowRule);
      expect(runner.systemPrompt()).toContain("Skip it for routine, local, obvious work.");
      expect(runner.systemPrompt()).toContain(
        "Follow any stricter workflow-specific system instruction",
      );
      await runner.dispose();
    },
    30_000,
  );

  testIfDocker("economy tier omits the advisor tool", async () => {
    const runner = new CapturingRunner("economy");
    await runner.start({ type: "start", mode: "agent" });

    expect(runner.toolNames()).not.toContain("ask_advisor");
    await runner.dispose();
  });

  testIfDocker("a delivered reroute nudge bypasses a closed gate exactly once", async () => {
    const runner = new NudgeRunner();
    await runner.start({ type: "start", mode: "agent" });
    const router = runner.router;
    if (!router) throw new Error("Expected routed runner");
    router.beginAdvisorConsult();
    router.endAdvisorConsult(true);

    const turn = runner.turn({
      type: "prompt",
      message: "Move from general implementation into architecture planning.",
      behavior: "follow_up",
    });
    const terminal = await turn;
    const injectedNudge = terminal.state.agent.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n"),
      )
      .find((text) => text.includes("This consult is cap-exempt"));

    expect(terminal.type).toBe("complete");
    expect(injectedNudge).toContain("changed from gpt-5.6-sol to fable-5 for the plan route");
    expect(router.advisorGate().allowed).toBe(false);
    expect(router.advisorGate().stepsUntilAllowed).toBeGreaterThan(0);

    let successfulConsults = 0;
    const advisor = createAskAdvisorTool({
      getContext: async () => ({
        systemPrompt: "You are the executor.",
        messages: [{ role: "user", content: "Plan the migration.", timestamp: 1 }],
        tools: [],
      }),
      resolveModel: () => ({
        modelName: "anthropic/claude-fable-5",
        contextWindowTokens: 200_000,
      }),
      thinkingLevel: "high",
      advisorGate: () => router.beginAdvisorConsult(),
      noteAdvisorConsult: (success = true) => {
        if (success) successfulConsults += 1;
        router.endAdvisorConsult(success);
      },
      recordUsage: () => {},
      callAdvisor: async () => ({
        advice: "Validate lease ownership before queue selection.",
        usage: {
          inputTokens: 12,
          inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 3,
          outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
          totalTokens: 15,
        },
      }),
    });
    const first = await advisor.execute("nudge-consult-1", {});
    const second = await advisor.execute("nudge-consult-2", {});

    expect(first.content).toEqual([
      { type: "text", text: "Validate lease ownership before queue selection." },
    ]);
    expect(second.details).toEqual(
      expect.objectContaining({ type: "ask_advisor", rateLimited: true }),
    );
    expect(successfulConsults).toBe(1);
    await runner.dispose();
  });
});
