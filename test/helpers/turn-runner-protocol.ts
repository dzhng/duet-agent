import { Agent } from "@mariozechner/pi-agent-core";
import {
  TurnRunner,
  type AgentConfigInput,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../../src/turn-runner/turn-runner.js";
import type { TurnRunnerControlResult } from "../../src/turn-runner/tools.js";
import type {
  StateAgentHandle,
  StateAgentResult,
} from "../../src/turn-runner/state-machine-controller.js";
import type { TurnRunnerConfig } from "../../src/types/config.js";
import type {
  TurnEvent,
  TurnMode,
  TurnState,
  TurnTerminalEvent,
} from "../../src/types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
} from "../../src/types/state-machine.js";
import { createAssistantMessage } from "./messages.js";

export class TestTurnRunner extends TurnRunner {
  readonly workerInputs: AgentWorkerInput[] = [];
  readonly agentConfigs: AgentConfigInput[] = [];
  readonly stateAgentInputs: Array<
    AgentWorkerInput & {
      appendSystemPrompt?: string;
      skills?: readonly { name: string }[];
    }
  > = [];
  controlResults: TurnRunnerControlResult[] = [];
  worker?: (
    input: AgentWorkerInput,
    next: () => Promise<AgentWorkerResult>,
  ) => Promise<AgentWorkerResult>;

  protected override async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (this.worker) {
      return this.worker(input, () => this.runDefaultWorker(input));
    }

    return this.runDefaultWorker(input);
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    this.agentConfigs.push(input);
    return super.createAgent(input, onControlResult);
  }

  protected async runDefaultWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerInputs.push(input);
    const control = this.controlResults.shift() ?? { type: "none" };
    const resultText = input.prompt.includes("capital of France")
      ? "Paris"
      : `Completed: ${input.prompt}`;
    const assistantMessage = createAssistantMessage({ text: resultText });
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

  protected override createStateAgentHandle(input: {
    state: StateMachineAgentState;
    prompt: string;
  }): StateAgentHandle {
    const state: TurnState = {
      status: "running",
      mode: "agent",
      options: this.getState()?.options,
      agent: { status: "running", messages: [] },
    };
    const workerInput = {
      state,
      prompt: input.prompt,
      appendSystemPrompt: input.state.systemPrompt,
      skills: this.skillContext.resolveStateAgentSkills(input.state),
    };
    this.stateAgentInputs.push(workerInput);
    let terminal: StateAgentResult | undefined;
    return {
      prompt: async () => {
        const result = this.worker
          ? await this.worker(workerInput, () => this.runDefaultWorker(workerInput))
          : await this.runDefaultWorker(workerInput);
        this.recordUsage(result.terminal.usage);
        if (result.control.type === "ask_user_question") {
          terminal = { type: "ask", questions: result.control.questions };
        } else if (result.terminal.type !== "complete") {
          terminal = { type: result.terminal.type } as StateAgentResult;
        } else if (result.terminal.status === "failed") {
          terminal = { type: "failed", error: result.terminal.error ?? "State agent failed." };
        } else {
          terminal = { type: "complete", result: result.terminal.result };
        }
        return terminal;
      },
      interrupt: () => {
        terminal = { type: "interrupted" };
      },
      partialAssistantText: () => (terminal?.type === "complete" ? terminal.result : undefined),
    };
  }
}

export function createTurnRunner(config?: Partial<TurnRunnerConfig>): {
  runner: TestTurnRunner;
  events: TurnEvent[];
} {
  const runner = new TestTurnRunner({
    model: "anthropic:claude-opus-4-7",
    skillDiscovery: { includeDefaults: false },
    ...config,
  });
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return { runner, events };
}

/**
 * Run setup and dispatch the first prompt against a runner. Mirrors the
 * common test pattern of "create a session and start the user's first turn"
 * now that `start` is a setup-only command.
 */
export async function startTurn<
  T extends {
    start: (input: any) => Promise<TurnState>;
    turn: (input: any) => Promise<TurnTerminalEvent>;
  },
>(
  runner: T,
  args: { mode?: TurnMode; prompt: string },
): Promise<{ state: TurnState; turn: Promise<TurnTerminalEvent> }> {
  const state = await runner.start({
    type: "start",
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
  });
  const turn = runner.turn({
    type: "prompt",
    message: args.prompt,
    behavior: "follow_up",
  });
  return { state, turn };
}

export function createStateMachineState(currentState: string): TurnState {
  const definition = createOutreachStateMachine();
  return {
    status: "running",
    mode: "auto",
    agent: {
      status: "running",
      messages: [],
    },
    stateMachine: {
      definition,
      prompt: "Prospect Ada until she books a meeting.",
      currentState,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

export function createOutreachStateMachine(): StateMachineDefinition {
  return {
    name: "conference_outreach",
    prompt:
      "Use for prospecting or outreach tasks where the goal is to contact someone and wait for a reply or meeting.",
    states: [
      {
        kind: "agent",
        name: "research_prospect",
        prompt: "Research the prospect and company.",
      },
      {
        kind: "script",
        name: "send_email",
        inputSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
        command: "scripts/send-email.sh '{{ input.email }}'",
      },
      {
        kind: "poll",
        name: "poll_email_reply",
        intervalMs: 300_000,
        poll: {
          kind: "script",
          command: "scripts/check-email-reply.sh '{{ input.email }}'",
        },
      },
      {
        kind: "poll",
        name: "wait_before_retry",
        intervalMs: 300_000,
        poll: {
          kind: "timer",
        },
      },
      {
        kind: "agent",
        name: "classify_reply",
        prompt: "Classify the email reply and update state.",
      },
      {
        kind: "agent",
        name: "waiting_for_reply",
        prompt: "Wait for or incorporate the prospect reply.",
      },
      {
        kind: "terminal",
        name: "meeting_scheduled",
        status: "completed",
      },
    ],
  };
}
