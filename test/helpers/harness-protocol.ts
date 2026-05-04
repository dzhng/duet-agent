import {
  Harness,
  type AgentWorkerInput,
  type AgentWorkerResult,
} from "../../src/harness/harness.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { HarnessControlResult } from "../../src/harness/tools.js";
import type { HarnessConfig } from "../../src/types/config.js";
import type { HarnessEvent, HarnessSession } from "../../src/types/protocol.js";
import type { StateMachineDefinition } from "../../src/types/state-machine.js";

export class TestHarness extends Harness {
  readonly workerInputs: AgentWorkerInput[] = [];
  controlResults: HarnessControlResult[] = [];
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

  private async runDefaultWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    this.workerInputs.push(input);
    const control = this.controlResults.shift() ?? { type: "none" };
    const resultText = input.prompt.includes("capital of France")
      ? "Paris"
      : `Completed: ${input.prompt}`;
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: resultText }],
      api: "unknown",
      provider: "unknown",
      model: "test",
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
    const session = {
      ...input.session,
      status: "completed" as const,
      agent: {
        status: "completed" as const,
        messages: [...input.session.agent.messages, assistantMessage],
      },
    };

    return {
      control,
      terminal: {
        type: "complete",
        status: "completed",
        result: resultText,
        session,
      },
    };
  }
}

export function createHarness(config?: Partial<HarnessConfig>): {
  harness: TestHarness;
  events: HarnessEvent[];
} {
  const harness = new TestHarness({
    harnessModel: "anthropic:claude-opus-4-6",
    skillDiscovery: { includeDefaults: false },
    ...config,
  });
  const events: HarnessEvent[] = [];
  harness.subscribe((event) => events.push(event));
  return { harness, events };
}

export function createStateMachineSession(currentState: string): HarnessSession {
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
      state: {},
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
        command: "scripts/send-email.sh '{{ state.email }}'",
      },
      {
        kind: "poll",
        name: "poll_email_reply",
        intervalMs: 300_000,
        poll: {
          kind: "script",
          command: "scripts/check-email-reply.sh '{{ state.email }}'",
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
