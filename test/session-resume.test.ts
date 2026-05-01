import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration, Model } from "@mariozechner/pi-ai";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { createAgentId, createMemoryId, createSessionId, createTaskId } from "../src/core/ids.js";
import type { AgentStatus, CommLayer, CommMessage, SessionState, Task } from "../src/core/types.js";

class TestComm implements CommLayer {
  sent: CommMessage[] = [];
  statuses: AgentStatus[] = [];

  async send(message: CommMessage): Promise<void> {
    this.sent.push(message);
  }

  async receive(): Promise<CommMessage> {
    throw new Error("TestComm does not receive messages");
  }

  onMessage(): () => void {
    return () => {};
  }

  async sendStatus(status: AgentStatus): Promise<void> {
    this.statuses.push(status);
  }
}

let faux: FauxProviderRegistration | undefined;

afterEach(() => {
  faux?.unregister();
  faux = undefined;
});

describe("Orchestrator session resume", () => {
  test("hydrates supplied memory and preserves the session id", async () => {
    const model = createFauxModel();
    const orchestrator = createOrchestrator(model);
    const sessionId = createSessionId();
    const messageId = createMemoryId();
    const observationId = createMemoryId();

    const state = createState({
      sessionId,
      phase: "complete",
    });

    const result = await orchestrator.run("ignored fresh goal", {
      state,
      messages: [
        {
          id: messageId,
          sessionId,
          createdAt: 1,
          role: "user",
          content: "continue from this user message",
        },
      ],
      memory: {
        observations: [
          {
            id: observationId,
            sessionId,
            createdAt: 1,
            observedDate: "2026-05-01",
            priority: "high",
            scope: "session",
            source: { kind: "user" },
            content: "Existing session preference",
            tags: ["resume"],
          },
        ],
      },
    });

    const snapshot = await (orchestrator as any).memory.getSnapshot(sessionId);

    expect(result.sessionId).toBe(sessionId);
    expect(snapshot.rawMessages.map((message: { id: string }) => message.id)).toEqual([messageId]);
    expect(snapshot.observations.map((observation: { id: string }) => observation.id)).toEqual([
      observationId,
    ]);
  });

  test("resumes executing sessions without re-planning", async () => {
    const model = createFauxModel();
    faux!.setResponses([
      fauxAssistantMessage("task completed"),
      fauxAssistantMessage("goal accomplished"),
    ]);
    const orchestrator = createOrchestrator(model);
    const state = createState({
      phase: "executing",
      tasks: [createTask("pending task", model, "pending")],
    });

    const result = await orchestrator.run("ignored fresh goal", { state });

    expect(faux!.state.callCount).toBe(2);
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.phase).toBe("complete");
  });

  test("retries in-progress tasks from pending on resume", async () => {
    const model = createFauxModel();
    faux!.setResponses([
      fauxAssistantMessage("retried task completed"),
      fauxAssistantMessage("goal accomplished"),
    ]);
    const orchestrator = createOrchestrator(model);
    const state = createState({
      phase: "executing",
      tasks: [createTask("interrupted task", model, "in_progress")],
    });

    const result = await orchestrator.run("ignored fresh goal", { state });

    expect(result.tasks[0]?.status).toBe("completed");
    expect(
      result.transitions.some((transition) => transition.trigger.includes("Starting pure task")),
    ).toBe(true);
  });
});

function createFauxModel(): Model<any> {
  faux = registerFauxProvider();
  return faux.getModel();
}

function createOrchestrator(model: Model<any>): Orchestrator {
  return new Orchestrator({
    orchestratorModel: model,
    defaultSubAgentModel: model,
    cwd: process.cwd(),
    comm: new TestComm(),
    skillDiscovery: { includeDefaults: false },
    memory: { enabled: false },
  });
}

function createState(input: {
  sessionId?: SessionState["sessionId"];
  phase: SessionState["phase"];
  tasks?: Task[];
}): SessionState {
  return {
    sessionId: input.sessionId ?? createSessionId(),
    goal: "resume this session",
    phase: input.phase,
    tasks: input.tasks ?? [],
    context: {},
    sessionMemories: [],
    transitions: [],
  };
}

function createTask(description: string, model: Model<any>, status: Task["status"]): Task {
  return {
    id: createTaskId(),
    description,
    agentSpec: {
      id: createAgentId(),
      role: "tester",
      instructions: "Complete the task and respond concisely.",
      model,
      allowedActions: [],
      maxTurns: 2,
      memoryAccess: "none",
    },
    status,
    dependencies: [],
    purity: "pure",
    memoriesCreated: [],
  };
}
