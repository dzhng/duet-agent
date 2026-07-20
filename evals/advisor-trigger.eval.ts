import { describe, expect } from "bun:test";
import { bestOfAttempts } from "../test/helpers/best-of.js";
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
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnUsageEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";

const executorModel = process.env.EVAL_MODEL ?? "sonnet-4.6";

interface CapturedToolCall {
  name: string;
  output?: string;
}

class CapturingRunner extends TurnRunner {
  readonly classifierInputs: ClassifierInput[] = [];

  constructor(model: "frontier" | "economy", systemInstructions?: string, cwd?: string) {
    super({
      model,
      mode: "agent",
      cwd,
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
          expect(advisorCalls.length).toBeGreaterThanOrEqual(1);
          expect(advisorCalls.some((call) => (call.output?.length ?? 0) > 0)).toBe(true);
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
    "substantive sequential work consults after orientation and at completion",
    async () => {
      await bestOfAttempts(2, async () => {
        const workDir = await mkdtemp(join(tmpdir(), "duet-advisor-lifecycle-"));
        const chainDir = join(workDir, "chain");
        await mkdir(chainDir);
        const chainLength = 10;
        await Promise.all(
          Array.from({ length: chainLength }, (_unused, index) => {
            const next = index === chainLength - 1 ? "END" : `node-${index + 1}.txt`;
            return writeFile(
              join(chainDir, `node-${index}.txt`),
              `fragment-${index}\nnext: ${next}\n`,
            );
          }),
        );

        const runner = new CapturingRunner(
          "frontier",
          dedent`
            This is a bounded live lifecycle evaluation. Use only the read and write tools for the
            task. Do not use bash, glob, search, or sub-agents. Each chain file reveals the only next
            filename you should read, so inspect one node at a time in the discovered order.
          `,
          workDir,
        );
        const toolCalls = captureToolCalls(runner);
        try {
          const { turn } = await startTurn(runner, {
            mode: "agent",
            prompt: dedent`
              Start at chain/node-0.txt and follow each next pointer until END. Preserve every
              fragment in order, write them one per line to answer.txt, read answer.txt back to
              verify it, then report completion.
            `,
          });
          const terminal = await turn;
          const names = toolCalls.map((call) => call.name);
          const advisorIndexes = names.flatMap((name, index) =>
            name === "ask_advisor" ? [index] : [],
          );
          const transcript = JSON.stringify(terminal.state.agent.messages);
          process.stdout.write(
            `${JSON.stringify({
              eval: "advisor-lifecycle",
              costUsd: terminal.turnUsage?.cost.total,
              costUsdByModel: terminal.usageByModel?.map((entry) => ({
                model: entry.model,
                costUsd: entry.usage.cost.total,
              })),
            })}\n`,
          );

          expect(terminal.type).toBe("complete");
          expect(transcript).toContain("orientation checkpoint");
          expect(transcript).toContain("completion-review checkpoint");
          expect(advisorIndexes.length).toBeGreaterThanOrEqual(2);
          expect(
            names.slice(0, advisorIndexes[0]).filter((name) => name === "read").length,
          ).toBeGreaterThanOrEqual(2);
          expect(
            names
              .slice(0, advisorIndexes.at(-1))
              .filter((name) => name === "read" || name === "write").length,
          ).toBeGreaterThanOrEqual(chainLength);
          expect(
            toolCalls.filter((call) => call.name === "ask_advisor").every((call) => call.output),
          ).toBe(true);
        } finally {
          await runner.dispose();
          await rm(workDir, { recursive: true, force: true });
        }
      });
    },
    600_000,
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
    "custom workflow guidance remains alongside product advisor policy",
    async () => {
      const workflowRule = "WORKFLOW-USES-BOUNDED-VALIDATION";
      const runner = new CapturingRunner("frontier", workflowRule);
      await runner.start({ type: "start", mode: "agent" });

      expect(runner.systemPrompt()).toContain(workflowRule);
      expect(runner.systemPrompt()).toContain("Skip consultation for routine, local,");
      expect(runner.systemPrompt()).not.toContain(
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
});
