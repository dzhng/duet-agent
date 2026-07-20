import { describe, expect } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "glm-5.2";
const SENTINEL = "ADVISOR-CONTEXT-7Q9M2X";

class AdvisorContextEvalRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      cwd,
      model: "advisor-context-eval",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  seedTranscript(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content:
          "Consult the advisor. Its concrete next action must quote the exact diagnostic marker at the end of the latest tool result.",
        timestamp: 1,
      },
      assistant([
        { type: "thinking", thinking: "The marker is only available in the tool result." },
        {
          type: "toolCall",
          id: "diagnostic-1",
          name: "bash",
          arguments: { command: "cat diagnostic-output.txt" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "diagnostic-1",
        toolName: "bash",
        content: [{ type: "text", text: `${"unimportant output\n".repeat(150)}${SENTINEL}` }],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 3,
      },
      assistant([
        { type: "text", text: "I will ask the advisor to identify the marker." },
        { type: "toolCall", id: "advisor-1", name: "ask_advisor", arguments: {} },
      ]),
    );
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }
}

describe("advisor context fidelity", () => {
  testIfDocker(
    "a live advisor can recover a marker beyond the old per-tool-result preview",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-context-eval-"));
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.defaultTier = "advisor-context-eval";
      table.tiers = {
        "advisor-context-eval": {
          routes: {
            general: {
              description: "Advisor context fidelity evaluation.",
              target: { modelName: model, thinkingLevel: "medium" },
            },
          },
          advisor: {
            enabled: true,
            target: { modelName: model, thinkingLevel: "medium" },
            minStepsBetween: 1,
          },
        },
      };
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));

      const runner = new AdvisorContextEvalRunner(cwd);
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedTranscript();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-1", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(JSON.stringify({ model, advice, details: result.details }, null, 2));

        expect(advice).toContain(SENTINEL);
        expect(result.details).toMatchObject({
          type: "ask_advisor",
          context: {
            truncated: false,
            omittedMessages: 0,
            includedMessages: 4,
          },
        });
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "duet-gateway",
    model: "executor-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}
