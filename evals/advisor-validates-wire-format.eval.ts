import { describe, expect } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "kimi-k3";
// Five runs made the unpatched prompt miss the actionable comment-prefix defect 3/5 times.
const ITERATIONS = Number(process.env.EVAL_ITERATIONS ?? "5");

class AdvisorWireFormatEvalRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      cwd,
      model: "advisor-wire-format-eval",
      mode: "agent",
      memoryDbPath: join(cwd, ".duet", "memory.db"),
      skillDiscovery: { includeDefaults: false },
    });
  }

  seedCompletionReview(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content:
          "Add an optional per-launcher summary to the TAP reporter. Include `Per-launcher summary` with `N tests, N pass, N fail, N skip` for each launcher.",
        timestamp: 1,
      },
      assistant(
        [
          {
            type: "toolCall",
            id: "read-contract",
            name: "read",
            arguments: { path: "lib/reporters/tap_reporter.js" },
          },
        ],
        2,
      ),
      {
        role: "toolResult",
        toolCallId: "read-contract",
        toolName: "read",
        content: [
          {
            type: "text",
            text: [
              "summaryDisplay() currently returns:",
              "# tests 4",
              "# pass  2",
              "# skip  1",
              "# fail  1",
            ].join("\n"),
          },
        ],
        isError: false,
        timestamp: 3,
      },
      assistant(
        [
          {
            type: "toolCall",
            id: "review-diff",
            name: "bash",
            arguments: { command: "git diff -- lib/reporters/tap_reporter.js" },
          },
        ],
        4,
      ),
      {
        role: "toolResult",
        toolCallId: "review-diff",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: [
              "+ let lines = ['Per-launcher summary'];",
              "+ lines.push(launcher + ': ' + s.total + ' tests, ' + s.pass + ' pass, ' + s.fail + ' fail, ' + s.skip + ' skip');",
              "+ return lines.join('\\n');",
            ].join("\n"),
          },
        ],
        isError: false,
        timestamp: 5,
      },
      assistant(
        [
          {
            type: "toolCall",
            id: "focused-tests",
            name: "bash",
            arguments: {
              command: "npx mocha tests/ci/reporter_tests.js --grep launcher-summary",
            },
          },
        ],
        6,
      ),
      {
        role: "toolResult",
        toolCallId: "focused-tests",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: "7 passing. The new executor-written test expects `Per-launcher summary` and `Chrome: 3 tests, 1 pass, 1 fail, 1 skip`.",
          },
        ],
        isError: false,
        timestamp: 7,
      },
    );
    // Push the relevant diff out of the raw tail, matching the long DeepSWE trace where later
    // compatibility checks caused normal observational compaction before completion review.
    for (let index = 0; index < 80; index += 1) {
      const toolCallId = `adjacent-check-${index}`;
      this.requireParentAgent().state.messages.push(
        assistant(
          [
            {
              type: "toolCall",
              id: toolCallId,
              name: "bash",
              arguments: { command: `inspect-adjacent-reporter-contract ${index}` },
            },
          ],
          8 + index * 2,
        ),
        {
          role: "toolResult",
          toolCallId,
          toolName: "bash",
          content: [
            {
              type: "text",
              text:
                `Adjacent reporter check ${index} passed without changing the TAP summary implementation.\n` +
                "unrelated compatibility evidence ".repeat(70),
            },
          ],
          isError: false,
          timestamp: 9 + index * 2,
        },
      );
    }
    this.requireParentAgent().state.messages.push(
      assistant(
        [
          {
            type: "text",
            text: "The implementation and focused/full tests are complete. Perform the final review before I commit.",
          },
          { type: "toolCall", id: "advisor-review", name: "ask_advisor", arguments: {} },
        ],
        168,
      ),
    );
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }
}

describe("advisor protocol review", () => {
  testIfDocker(
    "rejects executor-written tests that encode invalid TAP wire syntax",
    async () => {
      const missed: Array<{ iteration: number; advice: string }> = [];
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-wire-format-eval-"));
        const table = structuredClone(BUILT_IN_ROUTING_TABLE);
        table.defaultTier = "advisor-wire-format-eval";
        table.tiers = {
          "advisor-wire-format-eval": {
            routes: {
              general: {
                description: "Review one completed repository change.",
                target: { modelName: model, thinkingLevel: "medium" },
              },
            },
            advisor: {
              enabled: true,
              target: { modelName: model, thinkingLevel: "high" },
              minStepsBetween: 1,
            },
          },
        };
        await mkdir(join(cwd, ".duet"));
        await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
        const runner = new AdvisorWireFormatEvalRunner(cwd);
        const systemEvents: TurnEvent[] = [];
        runner.subscribe((event) => {
          if (event.type === "system") systemEvents.push(event);
        });
        try {
          await runner.start({ type: "start", mode: "agent" });
          runner.seedCompletionReview();
          const advisor = runner.advisorTool();
          if (!advisor) throw new Error("Expected ask_advisor tool");

          const result = await advisor.execute("advisor-review", {});
          const advice = result.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
          console.log(
            JSON.stringify({ iteration, advice, details: result.details, systemEvents }, null, 2),
          );
          const rejectsInvalidPatch =
            /Verdict:\s*(?:not ready|reject|do not approve|changes required)/i.test(advice);
          const namesExactTapPrefix =
            /`#(?: [^`]*)?`[\s\S]{0,80}(?:prefix|comment)|(?:prefix|comment)[\s\S]{0,80}`#(?: [^`]*)?`/i.test(
              advice,
            );
          if (!rejectsInvalidPatch || !namesExactTapPrefix) missed.push({ iteration, advice });
        } finally {
          await runner.dispose();
          await rm(cwd, { recursive: true, force: true });
        }
      }

      expect(missed).toEqual([]);
    },
    600_000,
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
