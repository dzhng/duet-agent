import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";

describe("state template strings", () => {
  test("renders transition input into agent state prompts", async () => {
    const runner = new EvalTurnRunner();
    runner.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: {
          kind: "run_state",
          state: "write_note",
          input: { topic: "feature flags", audience: "release managers" },
        },
      },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "done" },
      },
    );

    const terminal = await runner.turn({
      type: "start",
      mode: templateDefinition,
      prompt: "Write the note.",
    });

    expect(terminal.type).toBe("complete");
    expect(runner.workerInputs[1]?.prompt).toBe("Write about feature flags for release managers.");
  });

  test("renders transition input into script state commands", async () => {
    const runner = new EvalTurnRunner();
    runner.controlResults.push(
      {
        type: "select_state_machine_state",
        decision: {
          kind: "run_state",
          state: "echo_values",
          input: { topic: "feature flags", audience: "release managers" },
        },
      },
      {
        type: "select_state_machine_state",
        decision: { kind: "terminal", state: "done" },
      },
    );

    const terminal = await runner.turn({
      type: "start",
      mode: templateDefinition,
      prompt: "Echo the values.",
    });

    expect(terminal.type).toBe("complete");
    const completed = terminal.state.stateMachine?.history.find(
      (event) => event.type === "state_completed" && event.state === "echo_values",
    );
    expect(completed?.type === "state_completed" ? completed.output : undefined).toMatchObject({
      parsed: { topic: "feature flags", audience: "release managers" },
    });
  });
});

const templateDefinition: StateMachineDefinition = {
  name: "template_eval",
  prompt: "Use this state machine for template rendering evals.",
  states: [
    {
      kind: "agent",
      name: "write_note",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string" },
          audience: { type: "string" },
        },
        required: ["topic", "audience"],
      },
      prompt: "Write about {{ input.topic }} for {{ input.audience }}.",
    },
    {
      kind: "script",
      name: "echo_values",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string" },
          audience: { type: "string" },
        },
        required: ["topic", "audience"],
      },
      command: 'printf \'{"topic":"{{ input.topic }}","audience":"{{ input.audience }}"}\'',
    },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

class EvalTurnRunner extends TurnRunner {
  readonly workerInputs: AgentWorkerInput[] = [];
  readonly controlResults: TurnRunnerControlResult[] = [];

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerInputs.push(input);
    const control = this.controlResults.shift() ?? { type: "none" };
    const resultText = `Completed: ${input.prompt}`;
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: resultText }],
      api: "unknown",
      provider: "unknown",
      model: "eval",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const state = {
      ...input.state,
      status: "completed" as const,
      agent: {
        status: "completed" as const,
        messages: [...input.state.agent.messages, assistantMessage],
      },
    };

    return {
      control,
      terminal: {
        type: "complete",
        status: "completed",
        result: resultText,
        state,
      },
    };
  }
}
