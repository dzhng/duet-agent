import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const advisorThinking = parseThinkingLevel(
  process.env.EVAL_ADVISOR_THINKING ??
    BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor.target.thinkingLevel,
);

class AdvisorReviewEvalRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      cwd,
      model: "advisor-review-eval",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  seedLocallyGreenFix(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content: dedent`
          Fix Markdown link rewriting when a directory name contains a Markdown extension, such
          as file.md__static_image_assets__/image.png.
        `,
        timestamp: 1,
      },
      assistant([
        {
          type: "thinking",
          thinking:
            "The regex matches the .md prefix. Repository history may contain the upstream fix, but a boundary lookahead is smaller.",
        },
        {
          type: "toolCall",
          id: "inspect-1",
          name: "bash",
          arguments: { command: "sed -n '1,220p' packages/utils/src/markdownLinks.ts" },
        },
      ]),
      toolResult(
        "inspect-1",
        "bash",
        dedent`
          export const markdownLinkRegex = /(?<path>[^ ]+?\\.mdx?)/g;
        `,
        3,
      ),
      assistant([
        {
          type: "text",
          text: "I will ask the advisor whether the minimal boundary fix is sufficient.",
        },
        { type: "toolCall", id: "advisor-orientation", name: "ask_advisor", arguments: {} },
      ]),
      toolResult(
        "advisor-orientation",
        "ask_advisor",
        dedent`
          The lookahead family is the right minimal fix. Keep scope tight rather than replacing the
          parser. The untested terminators comma, semicolon, and single quote are acceptable
          narrowing because upstream tests do not cover them. This approach is correct.
        `,
        4,
      ),
      assistant([
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: {
            path: "packages/utils/src/markdownLinks.ts",
            oldText: "(?<path>[^ ]+?\\.mdx?)",
            newText: "(?<path>[^ ]+?\\.mdx?)(?=[?#\\s)>]|$)",
          },
        },
      ]),
      toolResult("edit-1", "edit", "Applied the narrow extension-boundary lookahead.", 5),
      assistant([
        {
          type: "toolCall",
          id: "edit-test-1",
          name: "edit",
          arguments: {
            path: "packages/utils/src/__tests__/markdownLinks.test.ts",
            oldText: "describe('markdown links', () => {",
            newText: dedent`
              describe('markdown links', () => {
                test('ignores partial file paths that contain .md', () => {
                  const input = '![image](./file.md__static_image_assets__/image.png)';
                  expect(replaceMarkdownLinks(input)).toBe(input);
                });
            `,
          },
        },
      ]),
      toolResult("edit-test-1", "edit", "Added the focused regression test.", 6),
      ...Array.from({ length: 24 }, (_, index) => {
        const id = `suite-${index + 1}`;
        return [
          assistant([
            {
              type: "toolCall",
              id,
              name: "bash",
              arguments: { command: `yarn test package-shard-${index + 1}` },
            },
          ]),
          toolResult(
            id,
            "bash",
            Array.from(
              { length: 250 },
              (_, caseIndex) => `package shard ${index + 1}, case ${caseIndex + 1}: passed`,
            ).join("\n"),
            7 + index,
          ),
        ];
      }).flat(),
      assistant([
        {
          type: "toolCall",
          id: "test-1",
          name: "bash",
          arguments: { command: "bun test markdownLinks --filter partial-file-path" },
        },
      ]),
      toolResult(
        "test-1",
        "bash",
        dedent`
          307 tests passed across the markdown loader and utility packages, including the new test:
          ignores partial file paths that contain .md. No failures.
        `,
        7,
      ),
      assistant([
        {
          type: "text",
          text: dedent`
            The regression and every available package test pass. The earlier advisor agreed the
            lookahead was the right minimal family, and existing tests do not require other
            terminators. I am ready to call this complete.
          `,
        },
        { type: "toolCall", id: "advisor-1", name: "ask_advisor", arguments: {} },
      ]),
    );
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }
}

describe("advisor completion review", () => {
  testIfDocker(
    "challenges a locally green narrow fix with authoritative and adjacent-contract checks",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-review-eval-"));
      const table = structuredClone(BUILT_IN_ROUTING_TABLE);
      table.defaultTier = "advisor-review-eval";
      table.tiers = {
        "advisor-review-eval": {
          routes: {
            general: {
              description: "Advisor completion-review evaluation.",
              target: { modelName: model, thinkingLevel: "medium" },
            },
          },
          advisor: {
            enabled: true,
            target: { modelName: model, thinkingLevel: advisorThinking },
            minStepsBetween: 1,
          },
        },
      };
      await mkdir(join(cwd, ".duet"));
      await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));

      const runner = new AdvisorReviewEvalRunner(cwd);
      const systemEvents: TurnEvent[] = [];
      runner.subscribe((event) => {
        if (event.type === "system") systemEvents.push(event);
      });
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedLocallyGreenFix();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-1", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(
          JSON.stringify(
            {
              model,
              advisorThinking,
              advice,
              details: result.details,
              systemEvents,
            },
            null,
            2,
          ),
        );

        expect(advice).toMatch(/history|upstream|reference implementation/i);
        expect(advice).toMatch(
          /do not approve|don't approve|not ready to (?:approve|complete)|not complete|don't mark complete|before declaring done|only after[\s\S]{0,120}(?:close|complete)/i,
        );
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

function parseThinkingLevel(value: string): ThinkingLevel {
  if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Unsupported EVAL_ADVISOR_THINKING: ${value}`);
}

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

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError: false,
    timestamp,
  };
}
