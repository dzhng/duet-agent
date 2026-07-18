import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { waitFor } from "./helpers/async.js";

const config = {
  model: "anthropic:claude-opus-4-7",
  mode: "auto" as const,
  memoryDbPath: false as const,
};

class CutoverRunner extends TurnRunner {
  controlTools(): AgentTool[] {
    return this.createTools("auto").tools.filter((tool) =>
      [
        "ask_user_question",
        "select_state_machine_state",
        "create_state_machine_definition",
      ].includes(tool.name),
    );
  }

  capture(result: TurnRunnerControlResult): void {
    (
      this as unknown as {
        captureParentControlResult(value: TurnRunnerControlResult): void;
      }
    ).captureParentControlResult(result);
  }
}

class ThrowingPassRunner extends TurnRunner {
  protected override async runAgentWorker(_input: AgentWorkerInput): Promise<AgentWorkerResult> {
    throw new Error("injected parent-pass failure");
  }
}

describe("TurnRunner cutover seams", () => {
  test("two control tools in one batch are sequential and the second capture is rejected", async () => {
    const runner = new CutoverRunner(config);
    await runner.start({ type: "start" });

    expect(runner.controlTools().map((tool) => tool.executionMode)).toEqual([
      "sequential",
      "sequential",
      "sequential",
    ]);
    runner.capture({
      type: "ask_user_question",
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
    });
    expect(() =>
      runner.capture({
        type: "ask_user_question",
        questions: [{ question: "Really?", options: [{ label: "Yes" }] }],
      }),
    ).toThrow("more than one control result");
  });

  test("interrupt emits one terminal when the parent has already unwound", async () => {
    const runner = new TurnRunner(config);
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });

    runner.interrupt({ type: "interrupt" });
    await waitFor(() => events.some((event) => event.type === "interrupted"));

    expect(events.filter((event) => event.type === "interrupted")).toHaveLength(1);
  });

  test("a thrown parent pass still emits exactly one failed terminal", async () => {
    const runner = new ThrowingPassRunner(config);
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));
    await runner.start({ type: "start" });

    const terminal = await runner.turn({
      type: "prompt",
      message: "trigger the injected throw",
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "failed",
      error: "injected parent-pass failure",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "complete" ||
          event.type === "ask" ||
          event.type === "sleep" ||
          event.type === "interrupted",
      ),
    ).toHaveLength(1);
  });
});
