import { expect, test } from "bun:test";
import { buildWorkflowReportEvidence } from "../evals/helpers/workflow-report.js";
import { createAssistantMessage } from "./helpers/messages.js";
import type { TurnEvent } from "../src/types/protocol.js";

function transcript(report?: string): TurnEvent[] {
  return [
    { type: "step", step: { type: "text_delta", delta: "streaming prefix" } },
    {
      type: "step",
      step: {
        type: "tool_call",
        toolCallId: "test-1",
        toolName: "bash",
        input: { command: "bun test" },
        isError: false,
        output: [{ type: "text", text: "tests passed" }],
      },
    },
    {
      type: "complete",
      status: "completed",
      result: "Relay selected done",
      state: {
        status: "completed",
        mode: "agent",
        agent: { status: "completed", messages: [createAssistantMessage({ text: report })] },
      },
    },
  ];
}

test("report evidence uses the actual final assistant, canonical tools, and exact user inputs", () => {
  const instructions = ["Make the search work", "You may commit; leave the display defect alone"];
  const evidence = buildWorkflowReportEvidence(
    transcript("Implemented search and ran bun test."),
    instructions,
  );
  expect(evidence.publicReport).toBe("Implemented search and ran bun test.");
  expect(evidence.userInstructions).toEqual(instructions);
  expect(evidence.toolResults).toEqual([
    {
      type: "tool_call",
      toolCallId: "test-1",
      toolName: "bash",
      input: { command: "bun test" },
      isError: false,
      output: [{ type: "text", text: "tests passed" }],
    },
  ]);
  expect(() => buildWorkflowReportEvidence(transcript(), instructions)).toThrow(
    "Missing final assistant report",
  );
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker(
  "judge input is saved before calling the model and infrastructure failure is not a rejection",
  async () => {
    const { judgeWorkflowReport } = await import("../evals/helpers/workflow-report.js");
    const root = await mkdtemp(join(tmpdir(), "workflow-report-"));
    try {
      const evidence = buildWorkflowReportEvidence(
        transcript("The provider is down; search remains unverified."),
        ["Report a concrete blocker if unavailable"],
      );
      const unavailable = await judgeWorkflowReport(
        {
          evidence,
          artifactDirectory: join(root, "unavailable"),
          expectation: "provider_unavailable",
        },
        async (request) => {
          const saved = JSON.parse(
            await readFile(join(root, "unavailable/judgment-input.json"), "utf8"),
          );
          expect(saved.request.value).toEqual(request.value);
          expect(saved.request.model).toBe("gpt-6-sol");
          throw new Error("upstream unavailable");
        },
      );
      expect(unavailable.status).toBe("evaluator_unavailable");
      expect(unavailable.error).toBe("upstream unavailable");
      const rejected = await judgeWorkflowReport(
        {
          evidence,
          artifactDirectory: join(root, "rejected"),
          expectation: "provider_unavailable",
        },
        async () => ({ valid: false, reason: "Unsupported completion claim" }),
      );
      expect(rejected.status).toBe("rejected");
      expect(rejected.verdict?.reason).toBe("Unsupported completion claim");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
