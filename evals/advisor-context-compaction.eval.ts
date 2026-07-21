import { describe, expect } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "glm-5.2";
const ARCHIVED_MARKER = "ARCHIVED-EVIDENCE-4H7K9P";
const RECENT_MARKER = "RECENT-EVIDENCE-8M2Q6T";

class AdvisorCompactionEvalRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      cwd,
      model: "advisor-compaction-eval",
      mode: "agent",
      memoryDbPath:
        process.env.FALSIFY_ADVISOR_COMPACTION === "1" ? false : join(cwd, ".duet", "memory.db"),
      skillDiscovery: { includeDefaults: false },
    });
  }

  seedTranscript(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content:
          "Ask the advisor to report both exact evidence markers. The archived marker is only in older work and the recent marker is in the current review request.",
        timestamp: 1,
      },
      assistant(
        [
          {
            type: "toolCall",
            id: "archive-1",
            name: "bash",
            arguments: { command: "cat archived-test-output.txt" },
          },
        ],
        2,
      ),
      {
        role: "toolResult",
        toolCallId: "archive-1",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: `${ARCHIVED_MARKER}\n${"historical passing output\n".repeat(9_000)}`,
          },
        ],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 3,
      },
      assistant(
        [
          {
            type: "toolCall",
            id: "recent-1",
            name: "bash",
            arguments: { command: "cat recent-test-output.txt" },
          },
        ],
        4,
      ),
      {
        role: "toolResult",
        toolCallId: "recent-1",
        toolName: "bash",
        content: [{ type: "text", text: RECENT_MARKER }],
        details: { exitCode: 0 },
        isError: false,
        timestamp: 5,
      },
      assistant(
        [
          {
            type: "text",
            text: "Report both exact markers from the archived and recent evidence.",
          },
          { type: "toolCall", id: "advisor-1", name: "ask_advisor", arguments: {} },
        ],
        6,
      ),
    );
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }
}

describe("advisor context compaction", () => {
  testIfDocker(
    "uses observations for older work and retains a bounded recent transcript",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-compaction-eval-"));
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.defaultTier = "advisor-compaction-eval";
      table.tiers = {
        "advisor-compaction-eval": {
          routes: {
            general: {
              description: "Advisor context compaction evaluation.",
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

      const runner = new AdvisorCompactionEvalRunner(cwd);
      const systemEvents: TurnEvent[] = [];
      runner.subscribe((event) => {
        if (event.type === "system") systemEvents.push(event);
      });
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
        console.log(
          JSON.stringify({ model, advice, details: result.details, systemEvents }, null, 2),
        );

        expect(advice).toContain(ARCHIVED_MARKER);
        expect(advice).toContain(RECENT_MARKER);
        const details = JSON.parse(JSON.stringify(result.details)) as {
          context?: { compactedMessages?: number; estimatedInputTokens?: number };
        };
        expect(Number(details.context?.compactedMessages)).toBeGreaterThan(0);
        expect(Number(details.context?.estimatedInputTokens)).toBeLessThanOrEqual(32_000);
        expect(details).toMatchObject({
          type: "ask_advisor",
          context: {
            inputTargetTokens: 32_000,
            compactedMessages: expect.any(Number),
            omittedMessages: 0,
            truncated: false,
          },
        });
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
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
    timestamp,
  };
}
