import { generateText, stepCountIs } from "ai";
import type {
  SubAgentSpec,
  MemoryStore,
  Sandbox,
  InterruptBus,
  Guardrail,
  SessionState,
} from "../core/types.js";
import type { TaskContext, TaskReport } from "../core/layers.js";
import { createTools } from "./tools.js";

export interface SubAgentRunnerDeps {
  memory: MemoryStore;
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
    sessionState: SessionState
  ): Promise<TaskReport> {
    const { memory, sandbox, interrupts, guardrail } = this.deps;

    // Build context from TaskContext — NOT from raw session state
    const depContext = taskContext.dependencyResults.length > 0
      ? "\n\n## Results from Prerequisite Tasks\n" +
        taskContext.dependencyResults
          .map((d) => `### ${d.taskDescription}\n${d.summary}`)
          .join("\n\n")
      : "";

    const memoryContext = taskContext.relevantMemories.length > 0
      ? "\n\n## Relevant Memories\n" +
        taskContext.relevantMemories.map((m) => `- ${m}`).join("\n")
      : "";

    const skillContext = taskContext.skillInstructions.length > 0
      ? "\n\n## Skills\n" + taskContext.skillInstructions.join("\n\n---\n\n")
      : "";

    const systemPrompt = `${spec.instructions}

## Your Task
${taskContext.task.description}

## Session Goal
${taskContext.sessionGoal}
${depContext}${memoryContext}${skillContext}

## Rules
- Use bash for everything. No MCP, no APIs — files and CLI only.
- Write memories for anything worth remembering beyond this task.
- If you're blocked or need clarification, use the interrupt tool.
- Stay focused on your specific task. Don't exceed your scope.`;

    const tools = createTools({
      agentId: spec.id,
      memory,
      sandbox,
      interrupts,
      guardrail,
      sessionState,
      allowedActions: spec.allowedActions,
    });

    try {
      const { text } = await generateText({
        model: spec.model,
        system: systemPrompt,
        prompt: `Execute the task: ${taskContext.task.description}`,
        tools,
        stopWhen: stepCountIs(spec.maxTurns),
        onStepFinish: () => {
          if (interrupts instanceof Object && "isPaused" in interrupts) {
            const ctrl = interrupts as any;
            if (ctrl.isPaused) {
              throw new Error("Agent paused by interrupt");
            }
          }
        },
      });

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
