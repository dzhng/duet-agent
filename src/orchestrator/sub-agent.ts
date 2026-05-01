import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type {
  MemoryStorage,
  ObservationalMemorySettings,
  SubAgentSpec,
  Sandbox,
  InterruptBus,
  Guardrail,
  SessionState,
} from "../core/types.js";
import type { TaskContext, TaskReport } from "../core/layers.js";
import { createTools } from "./tools.js";
import { createObservationalMemoryTransform } from "../memory/observational.js";

function extractText(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface SubAgentRunnerDeps {
  memory: MemoryStorage;
  observationalMemory?: boolean | Partial<ObservationalMemorySettings>;
  sandbox: Sandbox;
  interrupts: InterruptBus;
  guardrail?: Guardrail;
}

/**
 * Runs a dynamically-defined sub-agent against a task.
 *
 * The executor layer. It receives a sealed TaskContext from the orchestrator —
 * it CANNOT see the comm layer, other tasks' raw outputs, or the full session
 * state. This isolation prevents context pollution between layers.
 *
 * Sub-agents are NOT pre-built classes. They're defined on-the-fly by the
 * orchestrator — role, instructions, model, tools, constraints — everything
 * is specified per-task.
 */
export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  /**
   * Run a task using a sealed TaskContext.
   * The executor only knows: its task, the session goal, dependency summaries,
   * relevant memories, and skill instructions. Nothing else.
   */
  async run(
    spec: SubAgentSpec,
    taskContext: TaskContext,
    _sessionState: SessionState,
  ): Promise<TaskReport> {
    const { memory, observationalMemory, sandbox, interrupts } = this.deps;

    // Build context from TaskContext — NOT from raw session state
    const depContext =
      taskContext.dependencyResults.length > 0
        ? "\n\n## Results from Prerequisite Tasks\n" +
          taskContext.dependencyResults
            .map((d) => `### ${d.taskDescription}\n${d.summary}`)
            .join("\n\n")
        : "";

    const memoryContext =
      taskContext.relevantMemories.length > 0
        ? "\n\n## Relevant Memories\n" +
          taskContext.relevantMemories.map((m) => `- ${m}`).join("\n")
        : "";

    const skillContext =
      taskContext.skillInstructions.length > 0
        ? "\n\n## Skills\n" + taskContext.skillInstructions.join("\n\n---\n\n")
        : "";

    const systemPrompt = `${spec.instructions}

## Your Task
${taskContext.task.description}

## Session Goal
${taskContext.sessionGoal}
${depContext}${memoryContext}${skillContext}

## Rules
- Use pi coding tools only: read, bash, edit, and write. No MCP, no APIs.
- Use read instead of cat/sed for inspecting files.
- Use edit for precise changes and write only for new files or complete rewrites.
- If you're blocked or need clarification, explain that in your final response.
- Stay focused on your specific task. Don't exceed your scope.`;

    const tools = createTools({
      sandbox,
      allowedActions: spec.allowedActions,
    });

    try {
      let turns = 0;
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: spec.model,
          tools,
        },
        convertToLlm,
        transformContext: async (messages, signal) => {
          if (spec.memoryAccess === "none") {
            return messages;
          }
          return createObservationalMemoryTransform({
            store: memory,
            sessionId: _sessionState.sessionId,
            actorModel: spec.model,
            settings: observationalMemory,
          })(messages, signal);
        },
        toolExecution: "sequential",
      });

      agent.subscribe((event) => {
        if (event.type === "turn_end") {
          turns++;
          if (interrupts instanceof Object && "isPaused" in interrupts) {
            const ctrl = interrupts as any;
            if (ctrl.isPaused) {
              agent.abort();
            }
          }
          if (turns >= spec.maxTurns) {
            agent.abort();
          }
        }
      });

      await agent.prompt(`Execute the task: ${taskContext.task.description}`);
      const text = extractText(agent.state.messages);

      return {
        taskId: taskContext.task.id,
        agentId: spec.id,
        status: "completed",
        rawResult: text,
        memoriesCreated: [],
      };
    } catch (err: any) {
      return {
        taskId: taskContext.task.id,
        agentId: spec.id,
        status: "failed",
        rawResult: err.message,
        memoriesCreated: [],
      };
    }
  }
}
