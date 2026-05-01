import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";
import type {
  DuetAgentConfig,
  ObservationalMemorySettings,
  SessionState,
  Task,
  StateTransition,
  TaskId,
  SkillDiscoveryOptions,
} from "../core/types.js";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { OrchestratorToComm, TaskReport } from "../core/layers.js";
import { CommOrchestratorBridge, buildTaskContext } from "../core/bridges.js";
import { createSessionId, createAgentId, createTaskId } from "../core/ids.js";
import { InterruptController } from "../interrupt/controller.js";
import { SubAgentRunner } from "./sub-agent.js";
import { createFirewall } from "../guardrails/firewall.js";
import { PatternGuardrail } from "../guardrails/pattern.js";
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { createObservationalMemoryTransform } from "../memory/observational.js";
import { assistantText } from "../core/serializer.js";
import { MemoryStore } from "../memory/store.js";

function getSandboxCwd(sandbox: unknown): string {
  return (sandbox as { rootDir?: string }).rootDir ?? process.cwd();
}

function buildSkillDiscoveryOptions(options: SkillDiscoveryOptions | undefined, cwd: string) {
  const agentDir = options?.agentDir ?? join(homedir(), ".agents");
  const includeDefaults = options?.includeDefaults ?? true;
  return {
    cwd: options?.cwd ?? cwd,
    agentDir,
    includeDefaults: false,
    skillPaths: [
      ...(includeDefaults
        ? [join(agentDir, "skills"), join(options?.cwd ?? cwd, ".agents", "skills")]
        : []),
      ...(options?.skillPaths ?? []),
    ],
  };
}

type AgentContextTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

function createMemoryContextTransform(options: {
  memory: MemoryStore;
  sessionId: SessionState["sessionId"];
  actorModel: DuetAgentConfig["orchestratorModel"];
  memorySettings: Partial<ObservationalMemorySettings> | undefined;
}): AgentContextTransform {
  const observational = createObservationalMemoryTransform({
    store: options.memory,
    sessionId: options.sessionId,
    actorModel: options.actorModel,
    settings: options.memorySettings,
  });

  return observational;
}

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
 * Communication happens through layer bridges:
 * - Orchestrator ↔ Comm: via CommOrchestratorBridge (pushes state, asks user)
 * - Orchestrator ↔ Executor: via TaskContext/TaskReport (sealed contexts)
 * - Comm ↮ Executor: NO direct communication. Ever.
 */
export class Orchestrator {
  private interrupts: InterruptController;
  private runner: SubAgentRunner;
  private guardrail: ReturnType<typeof createFirewall>;
  private memory = new MemoryStore();
  private skills: Skill[] = [];
  private skillsLoaded = false;
  private memoryPersistenceLoaded = false;
  private memoryPersistenceDisposers: Array<() => void> = [];

  /** The bridge to the comm layer. Orchestrator talks to comm ONLY through this. */
  private commBridge: CommOrchestratorBridge;
  private comm: OrchestratorToComm;

  constructor(private readonly config: DuetAgentConfig) {
    this.interrupts = new InterruptController();

    // Set up the comm ↔ orchestrator bridge
    this.commBridge = new CommOrchestratorBridge(config.comm, this.interrupts);
    this.comm = this.commBridge.orchestratorSide;

    this.guardrail = createFirewall([new PatternGuardrail()]);

    for (const module of config.memoryPersistence ?? []) {
      const dispose = module.subscribe?.(this.memory);
      if (dispose) this.memoryPersistenceDisposers.push(dispose);
    }

    this.runner = new SubAgentRunner({
      memory: this.memory,
      memorySettings: config.memory,
      sandbox: config.sandbox,
      interrupts: this.interrupts,
      guardrail: this.guardrail,
    });

    // Wire up interrupt handler
    if (config.onInterrupt) {
      this.interrupts.on(config.onInterrupt);
    }

    // Seed with explicitly provided skills
    if (config.skills) {
      this.skills = [...config.skills];
    }
  }

  dispose(): void {
    for (const dispose of this.memoryPersistenceDisposers.splice(0)) {
      dispose();
    }
  }

  private async ensureMemoryPersistenceLoaded(): Promise<void> {
    if (this.memoryPersistenceLoaded) return;
    this.memoryPersistenceLoaded = true;

    for (const module of this.config.memoryPersistence ?? []) {
      await module.load?.(this.memory);
    }
  }

  /**
   * Load skills from discovery options. Called once before the first run.
   */
  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) return;
    this.skillsLoaded = true;

    const { skills: discovered } = loadSkills(
      buildSkillDiscoveryOptions(this.config.skillDiscovery, getSandboxCwd(this.config.sandbox)),
    );
    // Merge: explicit skills take priority (by name)
    const existingNames = new Set(this.skills.map((s) => s.name));
    for (const s of discovered) {
      if (!existingNames.has(s.name)) {
        this.skills.push(s);
      }
    }
  }

  /**
   * Run the full orchestration loop for a user goal.
   */
  async run(goal: string): Promise<SessionState> {
    await this.ensureMemoryPersistenceLoaded();
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

    // Push initial state to comm layer
    await this.pushState(state, "Starting planning...");
    await this.comm.sendStatus({ kind: "thinking", description: "Planning..." });

    // Phase 1: Plan — break goal into tasks with dynamic agent specs
    await this.plan(state);

    // Phase 2: Execute — pure tasks parallelized, effectful tasks sequential
    this.transition(state, "executing", "Planning complete, beginning execution");
    await this.pushState(state, "Execution started");
    await this.comm.sendStatus({
      kind: "executing",
      taskId: state.tasks[0]?.id as TaskId,
      description: "Executing tasks...",
    });
    await this.execute(state);

    // Phase 3: Evaluate — check results
    this.transition(state, "evaluating", "Execution complete, evaluating results");
    await this.pushState(state, "Evaluating results...");
    await this.evaluate(state);

    return state;
  }

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return [...this.skills];
  }

  /**
   * Push a state snapshot to the comm layer via the bridge.
   * This is the ONLY way the comm layer learns about state changes.
   */
  private async pushState(state: SessionState, description: string): Promise<void> {
    const snapshot = CommOrchestratorBridge.buildSnapshot(state, description);
    await this.comm.pushStateUpdate(snapshot);
  }

  /**
   * Build a skills context block for the orchestrator prompt.
   */
  private buildSkillsContext(): string {
    return formatSkillsForPrompt(this.skills);
  }

  /**
   * Get the full instructions for a skill, including reference doc content.
   */
  private getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.name === skillId);
    if (!skill) return "";
    return formatSkillsForPrompt([skill]);
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
    const addTaskSchema = Type.Object({
      description: Type.String({ description: "What this task accomplishes" }),
      purity: Type.Union([Type.Literal("pure"), Type.Literal("effectful")], {
        description:
          "pure = no side effects (reads, analysis, code gen). effectful = writes to external systems (CRM, email, deploy, API calls that modify state)",
      }),
      sideEffectDescription: Type.Optional(
        Type.String({
          description:
            "For effectful tasks: describe what external system is affected and how (e.g., 'Updates CRM contact record', 'Sends email via SendGrid')",
        }),
      ),
      agentRole: Type.String({
        description: "Role of the sub-agent (e.g., 'researcher', 'code-writer', 'reviewer')",
      }),
      agentInstructions: Type.String({
        description:
          "Detailed instructions for the sub-agent. If using a skill, include the skill instructions.",
      }),
      skillIds: Type.Optional(
        Type.Array(Type.String(), { description: "IDs of skills this agent should use" }),
      ),
      allowedActions: Type.Array(Type.String(), {
        description: "Tools this agent can use: read, bash, edit, write, or * for all",
      }),
      maxTurns: Type.Number({ description: "Maximum turns for this agent" }),
      dependencies: Type.Optional(
        Type.Array(Type.String(), { description: "Task descriptions this depends on" }),
      ),
      memoryAccess: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("session"), Type.Literal("none")], {
          description: "Memory access level",
        }),
      ),
    });

    const setContextSchema = Type.Object({
      key: Type.String(),
      value: Type.String(),
    });

    const planTools: AgentTool[] = [
      {
        name: "addTask",
        label: "Add Task",
        description:
          "Add a task to the execution plan. Define the sub-agent that will execute it. IMPORTANT: classify purity correctly — pure tasks get auto-parallelized, effectful tasks run one at a time.",
        parameters: addTaskSchema,
        execute: async (_toolCallId, params) => {
          const input = params as Static<typeof addTaskSchema>;
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
          return {
            content: [{ type: "text", text: `Added ${input.purity} task: ${input.description}` }],
            details: { taskId, agentId, description: input.description, purity: input.purity },
          };
        },
      },

      {
        name: "setContext",
        label: "Set Context",
        description: "Set a key-value pair in the session context, available to all sub-agents",
        parameters: setContextSchema,
        execute: async (_toolCallId, params) => {
          const input = params as Static<typeof setContextSchema>;
          state.context[input.key] = input.value;
          return {
            content: [{ type: "text", text: `Set context key: ${input.key}` }],
            details: { set: input.key },
          };
        },
      },
    ];

    // Recall relevant resource-scoped observations for planning context
    const memories = await this.memory.recall({
      query: state.goal,
      scope: "resource",
      limit: 10,
    });

    const memoryContext =
      memories.length > 0
        ? "\n\n## Relevant Observations\n" + memories.map((m) => `- ${m.content}`).join("\n")
        : "";

    const skillsContext = this.buildSkillsContext();

    const planner = new Agent({
      initialState: {
        model: this.config.orchestratorModel,
        tools: planTools,
        systemPrompt: `You are an orchestrator agent. Your job is to break down a user's goal into discrete tasks, and for each task, define a sub-agent with the right role, instructions, tools, and constraints.

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
- Sub-agents interact with the world through pi coding tools only: read, bash, edit, and write. No APIs, no MCP.
- Define agent instructions that are specific and actionable.
- Set appropriate tool permissions — don't give every agent edit/write access if they only need read or bash.
- Consider task dependencies — some tasks must complete before others can start.
- Use memory access wisely: "all" for agents that need historical context, "session" for task-local work, "none" for stateless operations.
- For effectful tasks, always set sideEffectDescription explaining what external system is affected.
${skillsContext}${memoryContext}`,
      },
      convertToLlm,
      transformContext: createMemoryContextTransform({
        memory: this.memory,
        sessionId: state.sessionId,
        actorModel: this.config.orchestratorModel,
        memorySettings: this.config.memory,
      }),
      toolExecution: "sequential",
    });
    let turns = 0;
    planner.subscribe((event) => {
      if (event.type === "turn_end" && ++turns >= 20) {
        planner.abort();
      }
    });
    await planner.prompt(`Break down this goal into tasks:\n\n${state.goal}`);
  }

  /**
   * Phase 2: Execute tasks with purity-aware scheduling.
   *
   * Pure tasks: auto-parallelized up to maxConcurrency when deps are met.
   * Effectful tasks: run one at a time, strictly sequentially.
   */
  private async execute(state: SessionState): Promise<void> {
    const maxConcurrency = this.config.maxConcurrency ?? 3;

    while (true) {
      // Check for interrupts
      if (this.interrupts.isPaused) {
        this.transition(state, "interrupted", "Paused by interrupt");
        await this.pushState(state, "Paused — handling interrupt");
        await this.handleInterrupt(state);
        if (state.phase === "interrupted") {
          this.transition(state, "planning", "Re-planning after interrupt");
          await this.pushState(state, "Re-planning...");
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
          }),
      );

      if (runnable.length === 0) {
        const allDone = state.tasks.every((t) => t.status === "completed" || t.status === "failed");
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
        (t) => t.purity === "effectful" && t.status === "in_progress",
      );

      if (pureTasks.length > 0 && !effectfulInProgress) {
        // Run pure tasks in parallel
        const batch = pureTasks.slice(0, maxConcurrency);
        this.transition(state, "executing", `Running ${batch.length} pure task(s) in parallel`);
        await this.pushState(state, `Running ${batch.length} pure task(s) in parallel`);
        await Promise.allSettled(batch.map((task) => this.runTask(task, state)));
      } else if (effectfulTasks.length > 0 && !effectfulInProgress) {
        // Run exactly ONE effectful task
        const task = effectfulTasks[0];
        this.transition(
          state,
          "executing",
          `Running effectful task: ${task.description} [${task.sideEffectDescription ?? "side effects"}]`,
        );
        await this.pushState(state, `Running effectful task: ${task.description}`);
        await this.runTask(task, state);
      } else if (effectfulInProgress) {
        await new Promise((r) => setTimeout(r, 100));
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /**
   * Run a single task via the sub-agent runner.
   *
   * Builds a sealed TaskContext — the executor CANNOT see the comm layer,
   * the full session state, or other tasks' raw results. This is the
   * orchestrator ↔ executor boundary.
   */
  private async runTask(task: Task, state: SessionState): Promise<void> {
    task.status = "in_progress";
    this.transition(
      state,
      "executing",
      `Starting ${task.purity} task: ${task.description}`,
      undefined,
      task.id,
    );

    await this.comm.sendStatus({
      kind: "executing",
      taskId: task.id,
      description: `[${task.purity}] ${task.description}`,
    });

    // Resolve skill instructions for this task
    const skillInstructions: string[] = [];
    // Skills are already embedded in agentSpec.instructions during planning

    // Fetch relevant observations for this task
    const relevantMemories: string[] = [];
    if (task.agentSpec.memoryAccess !== "none") {
      const memories = await this.memory.recall({
        sessionId: state.sessionId,
        query: task.description,
        scope: task.agentSpec.memoryAccess === "all" ? undefined : "session",
        limit: 5,
      });
      for (const m of memories) {
        relevantMemories.push(m.content);
      }
    }

    // Build the sealed TaskContext — this is all the executor gets to see
    const taskContext = buildTaskContext(
      task,
      state.goal,
      state,
      skillInstructions,
      relevantMemories,
    );

    try {
      const report: TaskReport = await this.runner.run(task.agentSpec, taskContext, state);

      if (report.status === "completed") {
        task.status = "completed";
        task.result = report.rawResult;
      } else if (report.status === "needs_review") {
        // Checkpoint — executor yielded for orchestrator review
        task.status = "blocked";
        task.result = report.rawResult;
        // TODO: implement checkpoint handling
      } else {
        task.status = "failed";
        task.error = report.rawResult;
      }

      // Track memories created during execution
      task.memoriesCreated.push(...(report.memoriesCreated as any[]));

      this.transition(
        state,
        "executing",
        `${report.status === "completed" ? "Completed" : "Failed"} ${task.purity} task: ${task.description}`,
        task.agentSpec.id,
        task.id,
      );

      await this.pushState(state, `Task ${report.status}: ${task.description}`);
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      this.transition(
        state,
        "executing",
        `Failed ${task.purity} task: ${task.description} — ${err.message}`,
        task.agentSpec.id,
        task.id,
      );
      await this.pushState(state, `Task failed: ${task.description}`);
    }
  }

  /**
   * Phase 3: Evaluate the results. The orchestrator reviews all task outputs
   * and determines if the goal was achieved.
   *
   * Note: only the orchestrator sees raw task results. The comm layer gets
   * a curated summary via pushStateUpdate.
   */
  private async evaluate(state: SessionState): Promise<void> {
    const completedTasks = state.tasks.filter((t) => t.status === "completed");
    const failedTasks = state.tasks.filter((t) => t.status === "failed");

    const summary = `## Task Results

### Completed (${completedTasks.length})
${completedTasks.map((t) => `- [${t.purity}] ${t.description}: ${t.result?.slice(0, 500) ?? "(no output)"}`).join("\n")}

### Failed (${failedTasks.length})
${failedTasks.map((t) => `- [${t.purity}] ${t.description}: ${t.error}`).join("\n")}`;

    const evaluationMessage = await completeSimple(this.config.orchestratorModel, {
      systemPrompt:
        "You are evaluating whether a set of completed tasks achieves the user's original goal. Be concise and direct.",
      messages: [
        {
          role: "user",
          content: `Goal: ${state.goal}\n\n${summary}\n\nDid the tasks achieve the goal? Summarize what was accomplished.`,
          timestamp: Date.now(),
        },
      ],
    });
    const evaluation = assistantText([evaluationMessage]);

    // Store evaluation as an observation for future sessions.
    await this.memory.appendObservation({
      sessionId: state.sessionId,
      observedDate: new Date().toISOString().slice(0, 10),
      timeOfDay: new Date().toISOString().slice(11, 16),
      priority: "high",
      scope: "resource",
      source: { kind: "agent", agentId: createAgentId() },
      content: `Session ${state.sessionId} evaluation: ${evaluation}`,
      tags: ["evaluation", "session-result"],
    });

    // Send the evaluation through the comm bridge — this is what the user sees
    await this.comm.sendMessage({ kind: "text", content: evaluation });
    this.transition(state, "complete", "Evaluation complete");
    await this.pushState(state, "Complete");
  }

  private async handleInterrupt(state: SessionState): Promise<void> {
    const queued = this.interrupts.drain();
    const pauseSource = queued.find((i) => i.priority === "pause")?.source;

    if (pauseSource?.kind === "user") {
      // Communicate back through the bridge, not directly
      await this.comm.sendMessage({
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
    taskId?: string,
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
