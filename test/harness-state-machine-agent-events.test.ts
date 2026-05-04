import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Harness, type AgentWorkerInput, type AgentWorkerResult } from "../src/harness/harness.js";
import type { HarnessEvent } from "../src/types/protocol.js";
import { createStateMachineSession } from "./helpers/harness-protocol.js";

class StateMachineAgentEventHarness extends Harness {
  private workerCalls = 0;

  constructor() {
    super({
      harnessModel: "anthropic:claude-opus-4-6",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerCalls += 1;

    if (this.workerCalls === 1) {
      return {
        control: {
          type: "select_state_machine_state",
          decision: { kind: "run_state", state: "research_prospect" },
        },
        terminal: {
          type: "complete",
          status: "completed",
          result: "Selected research state.",
          session: { ...input.session, status: "completed" },
        },
      };
    }

    this.emitAgentEvent({
      type: "message_update",
      message: { role: "assistant" } as never,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Child agent researched the prospect.",
        partial: { role: "assistant" } as never,
      },
    } satisfies AgentEvent);
    this.emitAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "profile.md" },
    });

    return {
      control: { type: "none" },
      terminal: {
        type: "complete",
        status: "completed",
        result: "Child state complete.",
        session: {
          ...input.session,
          status: "completed",
          agent: {
            ...input.session.agent,
            status: "completed",
          },
        },
      },
    };
  }
}

describe("State-machine agent state events", () => {
  test("emits child agent step events through the parent harness subscription", async () => {
    const harness = new StateMachineAgentEventHarness();
    const events: HarnessEvent[] = [];
    harness.subscribe((event) => events.push(event));

    await harness.turn({
      type: "prompt",
      session: createStateMachineSession("waiting_for_reply"),
      message: "Continue.",
      behavior: "follow_up",
    });

    expect(events).toContainEqual({
      type: "step",
      step: { type: "text", text: "Child agent researched the prospect." },
    });
    expect(events).toContainEqual({
      type: "step",
      step: {
        type: "tool_call",
        toolName: "read",
        toolCallId: "tool-1",
        status: "running",
        input: { path: "profile.md" },
      },
    });
  });
});
