import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type {
  DuetAgentConfig,
  SessionState,
  Task,
  TaskPurity,
  StateTransition,
  TaskId,
} from "../core/types.js";
import type { Skill } from "../skills/types.js";
import { createSessionId, createAgentId, createTaskId } from "../core/ids.js";
import { InterruptController } from "../interrupt/controller.js";
import { SubAgentRunner } from "./sub-agent.js";
import { createFirewall } from "../guardrails/firewall.js";
import { discoverAll } from "../skills/loader.js";

/**
 * The Orchestrator is the brain of duet-agent.
 *
 * It does NOT execute tasks itself. Instead it:
 * 1. Takes a user goal
 * 2. Breaks it into tasks (classifying each as pure or effectful)
 * 3. Dynamically defines sub-agent specs for each task
 * 4. Manages a session state machine where sub-agents drive transitions
 * 5. Auto-parallelizes pure tasks; runs effectful tasks sequentially
 * 6. Evaluates the final result
 *
 * Sub-agents are NOT tool calls the orchestrator executes. They're independent
 * actors that modify shared state. The orchestrator observes and adapts.
 */
export class Orchestrator {
  private interrupts: InterruptController;
  private runner: SubAgentRunner;
  private guardrail?: ReturnType<typeof createFirewall>;
  private skills: Skill[] = [];
  private skillsLoaded = false;

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

    // Seed with explicitly provided skills
    if (config.skills) {
      this.skills = [...config.skills];
    }
  }

  /**
   * Load skills from discovery options. Called once before the first run.
   */
  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) return;
    this.skillsLoaded = true;

    if (this.config.skillDiscovery) {
      const discovered = await discoverAll(this.config.skillDiscovery);
      // Merge: explicit skills take priority (by ID)
      const existingIds = new Set(this.skills.map((s) => s.id));
      for (const s of discovered) {
        if (!existingIds.has(s.id)) {
          this.skills.push(s);
        }
      }
    }
  }

  /**
   * Run the full orchestration loop for a user goal.
   */
  async run(goal: string): Promise<SessionState> {
    await this.ensureSkillsLoaded();

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

    // Phase 2: Execute — pure tasks parallelized, effectful tasks sequential
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
   * Build a skills context block for the orchestrator prompt.
   */
  private buildSkillsContext(): string {
    if (this.skills.length === 0) return "";

    const lines = this.skills.map((s) => {
      const fx = s.hasSideEffects ? " [HAS SIDE EFFECTS]" : "";
      const refs = s.references.length > 0
        ? ` (${s.references.length} reference docs available)`
        : "";
      return `- **${s.name}** (${s.id}): ${s.description}${fx}${refs}\n  Tools: ${s.tools.join(", ") || "none"}\n  Tags: ${s.tags.join(", ") || "none"}`;
    });

    return `\n\n## Available Skills\nThese skills provide additional capabilities. Include their instructions in sub-agent prompts when relevant. Skills marked [HAS SIDE EFFECTS] must be classified as effectful tasks.\n\n${lines.join("\n\n")}`;
  }

  /**
   * Get the full instructions for a skill, including reference doc content.
   */
  private getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) return "";

    let text = skill.instructions;
    if (skill.references.length > 0) {
      text += "\n\n## Reference Documentation\n";
      for (const ref of skill.references) {
        text += `\n### ${ref.title}\n${ref.content}\n`;
      }
    }
    return text;
  }

  /**
   * Phase 1: The orchestrator uses the smartest model to decompose the goal
   * into tasks and dynamically define sub-agent specs for each.
   *
   * Key addition: each task must be classified as "pure" or "effectful".
   * Pure tasks (read-only, analysis, code generation) get auto-parallelized.
   * Effectful tasks (CRM updates, deployments, emails) run sequentially.
   */
  private async plan(state: SessionState): Promise<void> {
    const addTaskSchema = z.object({
      description: z.string().describe("What this task accomplishes"),
      purity: z.enum(["pure", "effectful"]).describe(
        "pure = no side effects (reads, analysis, code gen). effectful = writes to external systems (CRM, email, deploy, API calls that modify state)"
      ),
      sideEffectDescription: z.string().optional().describe(
        "For effectful tasks: describe what external system is affected and how (e.g., 'Updates CRM contact record', 'Sends email via SendGrid')"
      ),
      agentRole: z.string().describe("Role of the sub-agent (e.g., 'researcher', 'code-writer', 'reviewer')"),
      agentInstructions: z.string().describe("Detailed instructions for the sub-agent. If using a skill, include the skill instructions."),
      skillIds: z.array(z.string()).optional().describe("IDs of skills this agent should use"),
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
        description: "Add a task to the execution plan. Define the sub-agent that will execute it. IMPORTANT: classify purity correctly — pure tasks get auto-parallelized, effectful tasks run one at a time.",
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

          // Build agent instructions with skill context
          let instructions = input.agentInstructions;
          if (input.skillIds) {
            for (const skillId of input.skillIds) {
              const skillInstr = this.getSkillInstructions(skillId);
              if (skillInstr) {
                instructions += `\n\n## Skill: ${skillId}\n${skillInstr}`;
              }
            }
          }

          const task: Task = {
            id: taskId,
            description: input.description,
            agentSpec: {
              id: agentId,
              role: input.agentRole,
              instructions,
              model: this.config.defaultSubAgentModel,
              allowedActions: input.allowedActions,
              maxTurns: input.maxTurns,
              memoryAccess: input.memoryAccess ?? "session",
            },
            status: "pending",
            dependencies: depIds,
            purity: input.purity,
            sideEffectDescription: input.sideEffectDescription,
            memoriesCreated: [],
          };

          state.tasks.push(task);
          return { taskId, agentId, description: input.description, purity: input.purity };
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

    const skillsContext = this.buildSkillsContext();

    await generateText({
      model: this.config.orchestratorModel,
      system: `You are an orchestrator agent. Your job is to break down a user's goal into discrete tasks, and for each task, define a sub-agent with the right role, instructions, tools, and constraints.

${this.config.systemInstructions ?? ""}

## Task Purity Classification

Every task MUST be classified as either "pure" or "effectful":

**pure** — No side effects. The task only reads data, analyzes information, generates code/text, or computes results. Examples:
- Reading and analyzing source code
- Generating a plan or design document
- Searching for information
- Writing code to local files in the sandbox
- Running tests (read-only verification)

**effectful** — Has side effects on external systems. The task modifies state outside the sandbox. Examples:
- Updating a CRM record
- Sending an email
- Deploying to production
- Making API calls that modify external data
- Publishing to a package registry
- Committing and pushing to git

Pure tasks with satisfied dependencies are automatically parallelized for maximum throughput.
Effectful tasks run ONE AT A TIME, in dependency order, to prevent race conditions and ensure auditability.

When a task has BOTH pure and effectful components, split it into two tasks:
1. A pure task that prepares the data/content
2. An effectful task (depending on the pure task) that performs the side effect

Rules:
- Each task should be independently executable by a sub-agent.
- Sub-agents interact with the world through bash and files only. No APIs, no MCP.
- Define agent instructions that are specific and actionable.
- Set appropriate tool permissions — don't give every agent write access if they only need to read.
- Consider task dependencies — some tasks must complete before others can start.
- Use memory access wisely: "all" for agents that need historical context, "session" for task-local work, "none" for stateless operations.
- For effectful tasks, always set sideEffectDescription explaining what external system is affected.
${skillsContext}${memoryContext}`,
      prompt: `Break down this goal into tasks:\n\n${state.goal}`,
      tools: planTools,
      stopWhen: stepCountIs(20),
    });
  }

  /**
   * Phase 2: Execute tasks with purity-aware scheduling.
   *
   * Pure tasks: auto-parallelized up to maxConcurrency when deps are met.
   * Effectful tasks: run one at a time, strictly sequentially.
   *
   * The scheduling algorithm:
   * 1. Find all runnable tasks (pending + deps satisfied)
   * 2. Partition into pure and effectful
   * 3. Run all pure tasks in parallel (up to maxConcurrency)
   * 4. Run at most ONE effectful task at a time
   * 5. Never run an effectful task in parallel with anything else
   */
  private async execute(state: SessionState): Promise<void> {
    const maxConcurrency = this.config.maxConcurrency ?? 3;

    while (true) {
      // Check for interrupts
      if (this.interrupts.isPaused) {
        this.transition(state, "interrupted", "Paused by interrupt");
        await this.handleInterrupt(state);
        if (state.phase === "interrupted") {
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
        const allDone = state.tasks.every(
          (t) => t.status === "completed" || t.status === "failed"
        );
        if (allDone) break;

        const hasInProgress = state.tasks.some((t) => t.status === "in_progress");
        if (!hasInProgress) break; // Deadlock

        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Partition by purity
      const pureTasks = runnable.filter((t) => t.purity === "pure");
      const effectfulTasks = runnable.filter((t) => t.purity === "effectful");

      // Check if any effectful task is currently in progress
      const effectfulInProgress = state.tasks.some(
        (t) => t.purity === "effectful" && t.status === "in_progress"
      );

      if (pureTasks.length > 0 && !effectfulInProgress) {
        // Run pure tasks in parallel
        const batch = pureTasks.slice(0, maxConcurrency);
        this.transition(
          state,
          "executing",
          `Running ${batch.length} pure task(s) in parallel`
        );
        await Promise.allSettled(batch.map((task) => this.runTask(task, state)));
      } else if (effectfulTasks.length > 0 && !effectfulInProgress) {
        // Run exactly ONE effectful task
        const task = effectfulTasks[0];
        this.transition(
          state,
          "executing",
          `Running effectful task: ${task.description} [${task.sideEffectDescription ?? "side effects"}]`
        );
        await this.runTask(task, state);
      } else if (effectfulInProgress) {
        // Wait for the effectful task to finish before scheduling anything
        await new Promise((r) => setTimeout(r, 100));
      } else {
        // Nothing to run, wait
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /**
   * Run a single task via the sub-agent runner.
   */
  private async runTask(task: Task, state: SessionState): Promise<void> {
    task.status = "in_progress";
    this.transition(
      state,
      "executing",
      `Starting ${task.purity} task: ${task.description}`,
      undefined,
      task.id
    );

    await this.config.comm.sendStatus({
      kind: "executing",
      taskId: task.id,
      description: `[${task.purity}] ${task.description}`,
    });

    try {
      const result = await this.runner.run(task.agentSpec, task, state);
      task.status = "completed";
      task.result = result;
      this.transition(
        state,
        "executing",
        `Completed ${task.purity} task: ${task.description}`,
        task.agentSpec.id,
        task.id
      );
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      this.transition(
        state,
        "executing",
        `Failed ${task.purity} task: ${task.description} — ${err.message}`,
        task.agentSpec.id,
        task.id
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
${completedTasks.map((t) => `- [${t.purity}] ${t.description}: ${t.result?.slice(0, 500) ?? "(no output)"}`).join("\n")}

### Failed (${failedTasks.length})
${failedTasks.map((t) => `- [${t.purity}] ${t.description}: ${t.error}`).join("\n")}`;

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

    await this.config.comm.send({ kind: "text", content: evaluation });
    this.transition(state, "complete", "Evaluation complete");
  }

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
