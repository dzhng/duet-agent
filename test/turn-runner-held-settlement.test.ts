import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { SubagentRun } from "../src/turn-runner/subagent.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createOutreachStateMachine } from "./helpers/turn-runner-protocol.js";

/**
 * A state-machine state runs as a task, so the parent loop idles waiting for
 * activity while the state's agent works. Inside the state, the agent starts
 * a slow command that outlives its foreground budget (it moves to the
 * background) and then waits on another command in the foreground. The
 * background one settles first, while the foreground wait is still open.
 */
class HeldSettlementRunner extends TurnRunner {
  private workerCalls = 0;
  foregroundResult?: AgentToolResult<unknown>;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerCalls += 1;
    if (this.workerCalls === 1) {
      return {
        control: { type: "select_state_machine_state", decision: { state: "research_prospect" } },
        outcome: {
          type: "complete",
          status: "completed",
          result: "Selected research state.",
          state: { ...input.state, status: "completed" },
        },
      };
    }
    return {
      control: { type: "none" },
      outcome: {
        type: "complete",
        status: "completed",
        result: "Parent done.",
        state: {
          ...input.state,
          status: "completed",
          agent: { ...input.state.agent, status: "completed" },
        },
      },
    };
  }

  protected override createStateSubagentRun(): SubagentRun {
    return {
      prompt: async () => {
        const bash = this.createTools("agent").tools.find((tool) => tool.name === "bash");
        if (!bash) throw new Error("bash tool missing");
        // Outlives its 50ms budget, so it converts to a background task and
        // settles ~200ms later — while the next call is still waiting.
        await bash.execute("bg", { command: "sleep 0.25 && printf bg-done", timeout: 0.05 });
        this.foregroundResult = await bash.execute("fg", {
          command: "sleep 0.5 && printf fg-done",
          timeout: 5,
        });
        return { type: "complete", result: "State done." };
      },
      interrupt: () => undefined,
      interruptedReason: () => undefined,
      partialAssistantText: () => undefined,
    };
  }
}

describe("settlements held behind a foreground wait", () => {
  test(
    "a background settlement during a state's foreground wait does not stall the turn",
    async () => {
      const runner = new HeldSettlementRunner();
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      await runner.start({ type: "start", mode: createOutreachStateMachine() });

      const terminal = await runner.turn({
        type: "prompt",
        message: "Continue.",
        behavior: "follow_up",
      });

      expect(terminal.type).toBe("complete");
      expect(runner.foregroundResult?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("fg-done"),
      });
      const settled = events.filter((event) => event.type === "task_settled");
      expect(settled.map((event) => event.settlement.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      await runner.dispose();
    },
    { timeout: 10_000 },
  );
});
