import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  TurnRunner,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../src/turn-runner/turn-runner.js";
import type { TurnQuestion, TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import type { TurnRunnerControlResult } from "../src/turn-runner/tools.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

describe("state-machine child agent resume", () => {
  testIfDocker("hydrates a child-agent ask terminal and resumes with an answer", async () => {
    const firstRunner = new EvalTurnRunner({
      childResults: [
        {
          type: "ask",
          questions: [
            { question: "Which company did Ada found?", options: [{ label: "Analytical" }] },
          ],
        },
      ],
      parentControls: [
        { type: "select_state_machine_state", decision: { kind: "run_state", state: "ask_child" } },
      ],
    });

    const askTerminal = await (
      await startTurn(firstRunner, {
        mode: childResumeDefinition,
        prompt: "Run the child state and ask for missing company context.",
      })
    ).turn;

    expect(askTerminal.type).toBe("ask");
    if (askTerminal.type !== "ask") throw new Error("Expected child agent to ask a question.");
    expect(askTerminal.state.status).toBe("waiting_for_human");
    expect(askTerminal.state.stateMachine?.currentState).toBe("ask_child");
    expect(messageTextFromAgent(askTerminal.state.childAgent)).toContain("What company?");

    const hydratedState = JSON.parse(JSON.stringify(askTerminal.state)) as TurnState;
    const secondRunner = new EvalTurnRunner({
      childResults: [{ type: "complete", text: "Used the hydrated answer." }],
      parentControls: [
        { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
      ],
    });
    await secondRunner.start({ type: "start", state: hydratedState });

    const terminal = await secondRunner.turn({
      type: "answer",
      questions: askTerminal.questions,
      answers: { company: "Analytical Engines Ltd." },
      behavior: "follow_up",
    });

    expect(terminal).toMatchObject({
      type: "complete",
      status: "completed",
      state: {
        status: "completed",
        stateMachine: { terminal: { state: "done", status: "completed" } },
      },
    });
    expect(secondRunner.childInputs).toHaveLength(1);
    expect(messageText(secondRunner.childInputs[0]!.state)).toContain("Analytical Engines Ltd.");
    expect(messageTextFromAgent(terminal.state.childAgent)).toContain("Used the hydrated answer.");
    expect(messageText(terminal.state)).not.toContain("Used the hydrated answer.");
  });

  testIfDocker("resumes child-agent transcripts across persisted statuses", async () => {
    const statuses = ["waiting", "completed", "failed", "cancelled"] as const;

    for (const status of statuses) {
      const runner = new EvalTurnRunner({
        childResults: [{ type: "complete", text: `Completed child ${status}.` }],
        parentControls: [
          { type: "prompt_state_machine_agent", prompt: "Continue the child state." },
          { type: "select_state_machine_state", decision: { kind: "terminal", state: "done" } },
        ],
      });
      const state: TurnState = {
        status: "running",
        mode: childResumeDefinition,
        agent: { status: "running", messages: [] },
        childAgent: {
          status,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `prior child ${status}` }],
              timestamp: Date.now(),
            },
          ],
        },
        stateMachine: {
          definition: childResumeDefinition,
          prompt: "Resume persisted child state.",
          currentState: "ask_child",
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
      await runner.start({ type: "start", state: JSON.parse(JSON.stringify(state)) as TurnState });

      const terminal = await runner.turn({
        type: "prompt",
        message: "Resume the child.",
        behavior: "follow_up",
      });

      expect(terminal).toMatchObject({ type: "complete", status: "completed" });
      expect(runner.childInputs).toHaveLength(1);
      expect(messageText(runner.childInputs[0]!.state)).toContain(`prior child ${status}`);
      expect(messageTextFromAgent(terminal.state.childAgent)).toContain(
        `Completed child ${status}.`,
      );
    }
  });
});

const childResumeDefinition: StateMachineDefinition = {
  name: "child_resume_eval",
  prompt: "Use this state machine to test child agent answer hydration.",
  states: [
    {
      kind: "agent",
      name: "ask_child",
      prompt: "Ask for missing company context, then use the answer.",
    },
    { kind: "terminal", name: "done", status: "completed" },
  ],
};

type ChildResult = { type: "ask"; questions: TurnQuestion[] } | { type: "complete"; text: string };

class EvalTurnRunner extends TurnRunner {
  readonly parentInputs: AgentWorkerInput[] = [];
  readonly childInputs: AgentWorkerInput[] = [];
  private readonly parentControls: TurnRunnerControlResult[];
  private readonly childResults: ChildResult[];

  constructor(input: { parentControls: TurnRunnerControlResult[]; childResults: ChildResult[] }) {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    this.parentControls = [...input.parentControls];
    this.childResults = [...input.childResults];
  }

  protected override async runAgentWorker(
    input: AgentWorkerInput,
    activeSlot: "parent" | "state_machine_child" = "parent",
  ): Promise<AgentWorkerResult> {
    if (activeSlot === "state_machine_child") {
      this.childInputs.push(input);
      const result = this.childResults.shift();
      if (!result) throw new Error("Missing child result");
      if (result.type === "ask") {
        return {
          control: { type: "ask_user_question", questions: result.questions },
          terminal: {
            type: "ask",
            questions: result.questions,
            state: {
              ...input.state,
              status: "waiting_for_human",
              agent: {
                status: "waiting",
                messages: [...input.state.agent.messages, assistantMessage("What company?")],
              },
            },
          },
        };
      }

      const state = {
        ...input.state,
        status: "completed" as const,
        agent: {
          status: "completed" as const,
          messages: [...input.state.agent.messages, assistantMessage(result.text)],
        },
      };
      return {
        control: { type: "none" },
        terminal: { type: "complete", status: "completed", result: result.text, state },
      };
    }

    this.parentInputs.push(input);
    const control = this.parentControls.shift() ?? { type: "none" };
    const state = {
      ...input.state,
      status: "completed" as const,
      agent: {
        status: "completed" as const,
        messages: [...input.state.agent.messages, assistantMessage("Parent decision.")],
      },
    };
    return {
      control,
      terminal: { type: "complete", status: "completed", result: "Parent decision.", state },
    };
  }
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
}

function messageText(state: TurnState): string {
  return messageTextFromAgent(state.agent);
}

function messageTextFromAgent(agent: TurnState["agent"] | undefined): string {
  return (agent?.messages ?? [])
    .map((message) => {
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join("\n");
    })
    .join("\n");
}
