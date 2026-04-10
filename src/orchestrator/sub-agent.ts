import { generateText, stepCountIs } from "ai";
import type {
  SubAgentSpec,
  Task,
  MemoryStore,
  Sandbox,
  InterruptBus,
  Guardrail,
  SessionState,
} from "../core/types.js";
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
 * Sub-agents are NOT pre-built classes. They're defined on-the-fly by the
 * orchestrator — role, instructions, model, tools, constraints — everything
 * is specified per-task. This is what makes duet-agent different from
 * frameworks that pre-register agent types.
 */
export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  async run(spec: SubAgentSpec, task: Task, sessionState: SessionState): Promise<string> {
    const { memory, sandbox, interrupts, guardrail } = this.deps;

    // Gather relevant memories for context
    let memoryContext = "";
    if (spec.memoryAccess !== "none") {
      const scope = spec.memoryAccess === "session" ? "session" : undefined;
      const memories = await memory.recall({
        query: task.description,
        scope,
        limit: 10,
      });
      if (memories.length > 0) {
        memoryContext = "\n\n## Relevant Memories\n" +
          memories.map((m) => `- [${m.tags.join(", ")}] ${m.content}`).join("\n");
      }
    }

    const systemPrompt = `${spec.instructions}

## Your Task
${task.description}

## Session Context
Goal: ${sessionState.goal}
Phase: ${sessionState.phase}
${memoryContext}

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

    const { text } = await generateText({
      model: spec.model,
      system: systemPrompt,
      prompt: `Execute the task: ${task.description}`,
      tools,
      stopWhen: stepCountIs(spec.maxTurns),
      onStepFinish: () => {
        // Check for interrupts between steps
        if (interrupts instanceof Object && "isPaused" in interrupts) {
          const ctrl = interrupts as any;
          if (ctrl.isPaused) {
            throw new Error("Agent paused by interrupt");
          }
        }
      },
    });

    return text;
  }
}
