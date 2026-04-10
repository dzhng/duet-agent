import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type {
  DuetAgentConfig,
  SessionState,
  Task,
  SubAgentSpec,
  StateTransition,
  TaskId,
} from "../core/types.js";
import { createSessionId, createAgentId, createTaskId } from "../core/ids.js";
import { InterruptController } from "../interrupt/controller.js";
import { SubAgentRunner } from "./sub-agent.js";
import { createFirewall } from "../guardrails/firewall.js";

/**
 * The Orchestrator is the brain of duet-agent.
 *
 * It does NOT execute tasks itself. Instead it:
 * 1. Takes a user goal
 * 2. Breaks it into tasks
 * 3. Dynamically defines sub-agent specs for each task
 * 4. Manages a session state machine where sub-agents drive transitions
 * 5. Evaluates the final result
 *
 * Sub-agents are NOT tool calls the orchestrator executes. They're independent
 * actors that modify shared state. The orchestrator observes and adapts.
 */
export class Orchestrator {
  private interrupts: InterruptController;
  private runner: SubAgentRunner;
  private guardrail?: ReturnType<typeof createFirewall>;

  constructor(private readonly config: DuetAgentConfig) {
    this.interrupts = new InterruptController();

    if (config.guardrails?.length) {
      this.guardrail = createFirewall(config.guardrails);
    }

    this.runner = new SubAgentRunner({
      memory: config.memory,
      sandbox: config.sandbox,
      interrupts: this.interrupts,
      guardrail: this.guardrail,
    });

    // Wire up interrupt handler
    if (config.onInterrupt) {
      this.interrupts.on(config.onInterrupt);
    }

    // Wire up comm layer interrupts (user messages become interrupts)
    config.comm.onMessage((msg) => {
      if (msg.kind === "text") {
        this.interrupts.emit({
          source: { kind: "user", message: msg.content },
          priority: "pause",
        });
      }
    });
  }

  /**
   * Run the full orchestration loop for a user goal.
   */
  async run(goal: string): Promise<SessionState> {
    const state: SessionState = {
      sessionId: createSessionId(),
      goal,
      phase: "planning",
      tasks: [],
      context: {},
      sessionMemories: [],
      transitions: [],
    };

    await this.config.comm.sendStatus({ kind: "thinking", description: "Planning..." });

    // Phase 1: Plan — break goal into tasks with dynamic agent specs
    await this.plan(state);

    // Phase 2: Execute — run sub-agents against tasks
    this.transition(state, "executing", "Planning complete, beginning execution");
    await this.config.comm.sendStatus({ kind: "executing", taskId: state.tasks[0]?.id as TaskId, description: "Executing tasks..." });
    await this.execute(state);

    // Phase 3: Evaluate — check results
    this.transition(state, "evaluating", "Execution complete, evaluating results");
    await this.evaluate(state);

    // Consolidate session memories
    await this.config.memory.consolidate();

    return state;
  }

  /**
   * Phase 1: The orchestrator uses the smartest model to decompose the goal
   * into tasks and dynamically define sub-agent specs for each.
   */
  private async plan(state: SessionState): Promise<void> {
    const addTaskSchema = z.object({
      description: z.string().describe("What this task accomplishes"),
      agentRole: z.string().describe("Role of the sub-agent (e.g., 'researcher', 'code-writer', 'reviewer')"),
      agentInstructions: z.string().describe("Detailed instructions for the sub-agent"),
      allowedActions: z.array(z.string()).describe("Tools this agent can use: bash, readFile, writeFile, glob, memoryWrite, memoryRecall, memoryForget, interrupt, or * for all"),
      maxTurns: z.number().describe("Maximum turns for this agent"),
      dependencies: z.array(z.string()).optional().describe("Task descriptions this depends on"),
      memoryAccess: z.enum(["all", "session", "none"]).optional().describe("Memory access level"),
    });

    const setContextSchema = z.object({
      key: z.string(),
      value: z.string(),
    });

    const planTools = {
      addTask: tool({
        description: "Add a task to the execution plan. Define the sub-agent that will execute it.",
        inputSchema: addTaskSchema,
        execute: async (input: z.infer<typeof addTaskSchema>) => {
          const taskId = createTaskId();
          const agentId = createAgentId();

          // Resolve dependency IDs
          const depIds: TaskId[] = [];
          if (input.dependencies) {
            for (const dep of input.dependencies) {
              const found = state.tasks.find((t) => t.description === dep);
              if (found) depIds.push(found.id);
            }
          }

          const task: Task = {
            id: taskId,
            description: input.description,
            agentSpec: {
              id: agentId,
              role: input.agentRole,
              instructions: input.agentInstructions,
              model: this.config.defaultSubAgentModel,
              allowedActions: input.allowedActions,
              maxTurns: input.maxTurns,
              memoryAccess: input.memoryAccess ?? "session",
            },
            status: "pending",
            dependencies: depIds,
            memoriesCreated: [],
          };

          state.tasks.push(task);
          return { taskId, agentId, description: input.description };
        },
      }),

      setContext: tool({
        description: "Set a key-value pair in the session context, available to all sub-agents",
        inputSchema: setContextSchema,
        execute: async (input: z.infer<typeof setContextSchema>) => {
          state.context[input.key] = input.value;
          return { set: input.key };
        },
      }),
    };

    // Recall relevant persistent memories for planning context
    const memories = await this.config.memory.recall({
      query: state.goal,
      scope: "persistent",
      limit: 10,
    });

    const memoryContext = memories.length > 0
      ? "\n\n## Relevant Memories\n" + memories.map((m) => `- ${m.content}`).join("\n")
      : "";

    await generateText({
      model: this.config.orchestratorModel,
      system: `You are an orchestrator agent. Your job is to break down a user's goal into discrete tasks, and for each task, define a sub-agent with the right role, instructions, tools, and constraints.

${this.config.systemInstructions ?? ""}

Rules:
- Each task should be independently executable by a sub-agent.
- Sub-agents interact with the world through bash and files only. No APIs, no MCP.
- Define agent instructions that are specific and actionable.
- Set appropriate tool permissions — don't give every agent write access if they only need to read.
- Consider task dependencies — some tasks must complete before others can start.
- Use memory access wisely: "all" for agents that need historical context, "session" for task-local work, "none" for stateless operations.
${memoryContext}`,
      prompt: `Break down this goal into tasks:\n\n${state.goal}`,
      tools: planTools,
      stopWhen: stepCountIs(20),
    });
  }

  /**
   * Phase 2: Execute tasks by running sub-agents.
   * Tasks respect dependencies. Independent tasks can run concurrently.
   */
  private async execute(state: SessionState): Promise<void> {
    const maxConcurrency = this.config.maxConcurrency ?? 3;

    while (true) {
      // Check for interrupts
      if (this.interrupts.isPaused) {
        this.transition(state, "interrupted", "Paused by interrupt");
        await this.handleInterrupt(state);
        if (state.phase === "interrupted") {
          // Re-plan after interrupt
          this.transition(state, "planning", "Re-planning after interrupt");
          await this.plan(state);
          this.transition(state, "executing", "Resuming execution");
        }
      }

      // Find runnable tasks (pending + all deps completed)
      const runnable = state.tasks.filter(
        (t) =>
          t.status === "pending" &&
          t.dependencies.every((depId) => {
            const dep = state.tasks.find((d) => d.id === depId);
            return dep?.status === "completed";
          })
      );

      if (runnable.length === 0) {
        // Check if we're done or stuck
        const allDone = state.tasks.every(
          (t) => t.status === "completed" || t.status === "failed"
        );
        if (allDone) break;

        const hasInProgress = state.tasks.some((t) => t.status === "in_progress");
        if (!hasInProgress) {
          // Deadlock — all remaining tasks have unmet dependencies
          break;
        }

        // Wait for in-progress tasks
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Run up to maxConcurrency tasks
      const batch = runnable.slice(0, maxConcurrency);
      await Promise.allSettled(
        batch.map(async (task) => {
          task.status = "in_progress";
          this.transition(state, "executing", `Starting task: ${task.description}`, undefined, task.id);

          await this.config.comm.sendStatus({
            kind: "executing",
            taskId: task.id,
            description: task.description,
          });

          try {
            const result = await this.runner.run(task.agentSpec, task, state);
            task.status = "completed";
            task.result = result;
            this.transition(state, "executing", `Completed task: ${task.description}`, task.agentSpec.id, task.id);
          } catch (err: any) {
            task.status = "failed";
            task.error = err.message;
            this.transition(state, "executing", `Failed task: ${task.description} — ${err.message}`, task.agentSpec.id, task.id);
          }
        })
      );
    }
  }

  /**
   * Phase 3: Evaluate the results. The orchestrator reviews all task outputs
   * and determines if the goal was achieved.
   */
  private async evaluate(state: SessionState): Promise<void> {
    const completedTasks = state.tasks.filter((t) => t.status === "completed");
    const failedTasks = state.tasks.filter((t) => t.status === "failed");

    const summary = `## Task Results

### Completed (${completedTasks.length})
${completedTasks.map((t) => `- ${t.description}: ${t.result?.slice(0, 500) ?? "(no output)"}`).join("\n")}

### Failed (${failedTasks.length})
${failedTasks.map((t) => `- ${t.description}: ${t.error}`).join("\n")}`;

    const { text: evaluation } = await generateText({
      model: this.config.orchestratorModel,
      system: `You are evaluating whether a set of completed tasks achieves the user's original goal. Be concise and direct.`,
      prompt: `Goal: ${state.goal}\n\n${summary}\n\nDid the tasks achieve the goal? Summarize what was accomplished.`,
      maxOutputTokens: 1000,
    });

    // Store evaluation as a session memory
    await this.config.memory.write({
      author: createAgentId(),
      createdAt: Date.now(),
      content: `Session ${state.sessionId} evaluation: ${evaluation}`,
      tags: ["evaluation", "session-result"],
      importance: 0.8,
      scope: "persistent",
    });

    // Send result to user
    await this.config.comm.send({ kind: "text", content: evaluation });

    this.transition(state, "complete", "Evaluation complete");
  }

  /**
   * Handle an interrupt — pause execution, consult the user or
   * environment, then decide how to proceed.
   */
  private async handleInterrupt(state: SessionState): Promise<void> {
    const queued = this.interrupts.drain();
    const pauseSource = queued.find((i) => i.priority === "pause")?.source;

    if (pauseSource?.kind === "user") {
      await this.config.comm.send({
        kind: "text",
        content: `Received your input: "${pauseSource.message}". Adjusting plan...`,
      });

      state.context["lastUserInterrupt"] = pauseSource.message;
    }

    this.interrupts.resume();
  }

  private transition(
    state: SessionState,
    toPhase: SessionState["phase"],
    trigger: string,
    agentId?: string,
    taskId?: string
  ): void {
    const t: StateTransition = {
      timestamp: Date.now(),
      fromPhase: state.phase,
      toPhase,
      trigger,
      agentId: agentId as any,
      taskId: taskId as any,
    };
    state.transitions.push(t);
    state.phase = toPhase;
    this.config.onTransition?.(t, state);
  }
}
