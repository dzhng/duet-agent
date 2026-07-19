import { afterEach, beforeEach, describe, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { bootTui, type TuiHarness } from "./helpers/tui-harness.js";
import { testIfDocker } from "./helpers/docker-only.js";

const FIXTURE_URL = new URL("./fixtures/tui/task-tree-active-frame.txt", import.meta.url);

describe("TUI task tree frame", () => {
  let harness: TuiHarness;

  beforeEach(async () => {
    harness = await bootTui({ width: 140, height: 36 });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  testIfDocker("renders the accepted concurrent task-tree structure", async () => {
    const now = Date.now();
    harness.runner.emitEvent({
      type: "task_started",
      task: {
        id: "t3",
        kind: "tool",
        name: "bash",
        label: "npm test",
        ownerScopeId: "turn-1",
        status: "running",
        startedAt: now - 252_000,
      },
    });
    harness.runner.emitEvent({
      type: "task_settled",
      settlement: { id: "t3", status: "completed", settledAt: now, result: "green" },
    });
    harness.runner.emitEvent({
      type: "task_started",
      task: {
        id: "t4",
        kind: "subagent",
        name: "spawn_agent",
        label: "audit auth flows",
        ownerScopeId: "turn-1",
        status: "running",
        startedAt: now - 363_000,
      },
    });
    harness.runner.emitEvent({
      type: "task_started",
      task: {
        id: "t7",
        kind: "tool",
        name: "bash",
        label: "rg -n rate_limit",
        ownerScopeId: "task:t4",
        status: "running",
        startedAt: now - 8_000,
      },
    });
    harness.runner.emitEvent({
      type: "task_started",
      task: {
        id: "t5",
        kind: "scheduled",
        name: "poll",
        label: "deploy-status",
        ownerScopeId: "turn-1",
        status: "scheduled",
        startedAt: now,
        wakeAt: now + 60_000,
      },
    });
    harness.runner.emitEvent({ type: "usage", ...usageFields(2_000) });
    harness.runner.emitEvent({
      type: "usage",
      ...usageFields(14_400),
      origin: { taskId: "t4" },
    });
    harness.runner.emitEvent({
      type: "step",
      step: { type: "text", text: "Reviewing audit results before summarizing." },
    });
    harness.runner.emitEvent({
      type: "heartbeat",
      timestamp: now,
      activeTaskIds: ["t4", "t7"],
    });
    await harness.flush();

    const frame = await harness.captureCharFrame();
    const stableFrame = normalizeVolatileTaskTiming(frame);
    const fixtureLines = (await readFile(FIXTURE_URL, "utf8")).trimEnd().split("\n");
    for (const line of fixtureLines) expect(stableFrame).toContain(line);
    expect(frame).not.toContain("heartbeat");
    expect(frame).not.toContain("task_started");
    expect(frame).not.toContain("task_output");
    expect(frame).not.toContain("task_settled");

    harness.runner.emitEvent({
      type: "task_output",
      taskId: "t7",
      chunk: "scanning 24 files",
    });
    await harness.flush();
    const outputFrame = await harness.captureCharFrame();
    expect(outputFrame).toContain("t7 bash `rg -n rate_limit` — scanning 24 files");
    expect(outputFrame).not.toContain("task_output");

    harness.runner.emitEvent({
      type: "task_settled",
      settlement: { id: "t4", status: "completed", settledAt: now, result: "audit" },
    });
    harness.runner.emitEvent({
      type: "task_settled",
      settlement: { id: "t7", status: "completed", settledAt: now, result: "search" },
    });
    await harness.flush();
    const awaitingTerminalFrame = await harness.captureCharFrame();
    expect(awaitingTerminalFrame).toContain(
      "● parent — Reviewing audit results before summarizing.",
    );
    expect(awaitingTerminalFrame).not.toContain("turn open: held awake by");

    const terminal = harness.waitForTerminal();
    harness.runner.emitEvent({
      type: "complete",
      status: "completed",
      result: "done",
      state: {
        status: "completed",
        mode: "agent",
        agent: { status: "completed", messages: [] },
      },
    });
    await terminal;
    const terminalFrame = await harness.captureCharFrame();
    expect(terminalFrame).not.toContain("● Reviewing audit results");
  });
});

function usageFields(totalTokens: number) {
  const usage = {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    turnUsage: usage,
    usageByModel: [],
    lastMessageUsage: usage,
    effectiveContextWindow: 200_000,
    contextWindowUsage: {
      systemPrompt: totalTokens,
      messages: 0,
      localMemory: 0,
      globalMemory: 0,
    },
  };
}

function normalizeVolatileTaskTiming(frame: string): string {
  return frame
    .replace(/ \d+(?:m\d{2}s|s)(?= {3}\[|[ \t]*│)/g, " <elapsed>")
    .replace(/(— wakes) [^\n│]+/g, "$1 <wake>");
}
