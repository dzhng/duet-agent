/**
 * Bridge implementations that wire adjacent layers together.
 *
 * These are the "glue" between comm ↔ orchestrator and orchestrator ↔ executor.
 * They enforce the layer boundaries — comm never talks to executor, executor
 * never talks to comm.
 */

import type { CommLayer, SessionState, Task, CommMessage, AgentStatus } from "./types.js";
import type { InterruptBus } from "./types.js";
import type {
  StateSnapshot,
  TaskSummary,
  CommToOrchestrator,
  OrchestratorToComm,
  TaskContext,
  TaskReport,
  DependencyResult,
  CheckpointAction,
} from "./layers.js";

// ---------------------------------------------------------------------------
// Comm ↔ Orchestrator Bridge
// ---------------------------------------------------------------------------

/**
 * Bridges the comm layer and orchestrator.
 *
 * The comm side gets: pull state, send messages, request updates.
 * The orchestrator side gets: push updates, ask user, send messages.
 */
export class CommOrchestratorBridge {
  private currentSnapshot: StateSnapshot;
  private pendingUserResponse: ((msg: string) => void) | null = null;

  constructor(
    private readonly comm: CommLayer,
    private readonly interrupts: InterruptBus,
  ) {
    this.currentSnapshot = {
      sessionId: "",
      goal: "",
      phase: "planning",
      tasks: [],
      progressDescription: "Initializing...",
      timestamp: Date.now(),
    };

    // Wire comm incoming messages to orchestrator interrupts
    comm.onMessage((msg) => {
      if (msg.kind === "text") {
        // If someone is waiting for a user response (askUser), resolve it
        if (this.pendingUserResponse) {
          const resolve = this.pendingUserResponse;
          this.pendingUserResponse = null;
          resolve(msg.content);
        } else {
          // Otherwise, forward as an interrupt to the orchestrator
          interrupts.emit({
            source: { kind: "user", message: msg.content },
            priority: "pause",
          });
        }
      }
    });
  }

  /** The interface exposed to the comm layer. */
  get commSide(): CommToOrchestrator {
    return {
      getState: () => this.currentSnapshot,
      sendUserMessage: (message: string) => {
        this.interrupts.emit({
          source: { kind: "user", message },
          priority: "pause",
        });
      },
      requestUpdate: async () => {
        return this.currentSnapshot.progressDescription;
      },
    };
  }

  /** The interface exposed to the orchestrator. */
  get orchestratorSide(): OrchestratorToComm {
    return {
      pushStateUpdate: async (snapshot: StateSnapshot, message?: string) => {
        this.currentSnapshot = snapshot;
        if (message) {
          await this.comm.send({ kind: "text", content: message });
        }
      },
      sendMessage: async (message: CommMessage) => {
        await this.comm.send(message);
      },
      askUser: async (question: string) => {
        await this.comm.send({ kind: "text", content: question });
        return new Promise<string>((resolve) => {
          this.pendingUserResponse = resolve;
        });
      },
      sendStatus: async (status: AgentStatus) => {
        await this.comm.sendStatus(status);
      },
    };
  }

  /**
   * Build a state snapshot from the full session state.
   * This is where the orchestrator controls what the comm layer sees.
   */
  static buildSnapshot(
    state: SessionState,
    progressDescription: string,
    taskSummaries?: Map<string, string>,
  ): StateSnapshot {
    return {
      sessionId: state.sessionId,
      goal: state.goal,
      phase: state.phase,
      tasks: state.tasks.map(
        (t): TaskSummary => ({
          id: t.id,
          description: t.description,
          status: t.status,
          purity: t.purity,
          resultSummary: taskSummaries?.get(t.id) ?? undefined,
          error: t.error,
        }),
      ),
      progressDescription,
      timestamp: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator ↔ Executor Bridge
// ---------------------------------------------------------------------------

/**
 * Builds the sealed TaskContext that an executor receives.
 * The executor CANNOT see: the comm layer, other tasks' raw results,
 * the full session state, or the orchestrator's internal state.
 */
export function buildTaskContext(
  task: Task,
  sessionGoal: string,
  state: SessionState,
  skillInstructions: string[],
  relevantMemories: string[],
): TaskContext {
  // Curate dependency results — only include summaries, not raw output
  const dependencyResults: DependencyResult[] = task.dependencies
    .map((depId) => {
      const dep = state.tasks.find((t) => t.id === depId);
      if (!dep || dep.status !== "completed") return null;
      return {
        taskDescription: dep.description,
        // Truncate raw result to prevent context pollution
        summary: dep.result?.slice(0, 2000) ?? "(completed, no output)",
      };
    })
    .filter((d): d is DependencyResult => d !== null);

  return {
    task,
    sessionGoal,
    dependencyResults,
    relevantMemories,
    skillInstructions,
  };
}
