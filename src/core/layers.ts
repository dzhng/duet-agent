/**
 * Layer boundaries for duet-agent.
 *
 * The system has 3 layers:
 *
 *   Comm ←→ Orchestrator ←→ Executor
 *
 * Adjacent layers talk to each other. Non-adjacent layers DON'T.
 * This prevents context pollution — the executor never knows how the
 * user is being talked to, and the comm layer never sees raw tool outputs.
 *
 * Comm ↔ Orchestrator:
 *   - Orchestrator pushes state updates to comm (phase changes, task progress)
 *   - Comm can pull the latest state snapshot at any time
 *   - Comm forwards user messages as interrupts to orchestrator
 *   - Orchestrator can explicitly request user input via comm
 *
 * Orchestrator ↔ Executor:
 *   - Orchestrator provides task context (instructions, tools, memory scope)
 *   - Executor returns task results
 *   - State machine can include "checkpoint" steps where executor yields
 *     to orchestrator for review before continuing
 *   - Executor can signal the orchestrator via interrupts (blocked, needs help)
 *
 * Comm ↮ Executor:
 *   - NO direct communication. Ever.
 *   - If a user message needs to reach an executor, it goes through orchestrator.
 *   - If an executor result needs to reach the user, orchestrator summarizes it.
 */

import type { SessionState, Task, TaskId, AgentId, CommMessage, AgentStatus } from "./types.js";

// ---------------------------------------------------------------------------
// State Snapshot (what comm sees — orchestrator controls what's exposed)
// ---------------------------------------------------------------------------

/**
 * A read-only snapshot of the session state, curated by the orchestrator
 * for the comm layer. This is NOT the full SessionState — it's what the
 * user should see.
 */
export interface StateSnapshot {
  sessionId: string;
  goal: string;
  phase: SessionState["phase"];
  /** Task summaries — no agent specs, no raw results. */
  tasks: TaskSummary[];
  /** High-level progress description. */
  progressDescription: string;
  /** Timestamp of this snapshot. */
  timestamp: number;
}

export interface TaskSummary {
  id: TaskId;
  description: string;
  status: string;
  purity: string;
  /** Orchestrator-curated summary of the result (not raw output). */
  resultSummary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Comm → Orchestrator boundary
// ---------------------------------------------------------------------------

/**
 * The interface that the comm layer uses to talk to the orchestrator.
 * Comm can pull state, send user messages, and request attention.
 */
export interface CommToOrchestrator {
  /** Pull the latest state snapshot. Non-blocking. */
  getState(): StateSnapshot;
  /** Forward a user message to the orchestrator as an interrupt. */
  sendUserMessage(message: string): void;
  /** Request that the orchestrator provide a progress update. */
  requestUpdate(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Orchestrator → Comm boundary
// ---------------------------------------------------------------------------

/**
 * The interface that the orchestrator uses to talk to the comm layer.
 * Orchestrator pushes updates, asks for user input, and signals status.
 */
export interface OrchestratorToComm {
  /** Push a state update to the user. */
  pushStateUpdate(snapshot: StateSnapshot, message?: string): Promise<void>;
  /** Send a message to the user. */
  sendMessage(message: CommMessage): Promise<void>;
  /** Ask the user a question and wait for a response. */
  askUser(question: string): Promise<string>;
  /** Update the agent status indicator (thinking, executing, etc). */
  sendStatus(status: AgentStatus): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator → Executor boundary
// ---------------------------------------------------------------------------

/**
 * What the orchestrator provides to the executor for a task.
 * This is a sealed context — the executor cannot see the full session state,
 * the comm layer, or other executors' raw outputs.
 */
export interface TaskContext {
  /** The task to execute. */
  task: Task;
  /** Goal of the overall session (for context, not for the executor to act on). */
  sessionGoal: string;
  /** Relevant context from completed dependency tasks (orchestrator-curated). */
  dependencyResults: DependencyResult[];
  /** Relevant memories (pre-fetched by orchestrator based on task). */
  relevantMemories: string[];
  /** Skill instructions to include (pre-resolved by orchestrator). */
  skillInstructions: string[];
}

export interface DependencyResult {
  taskDescription: string;
  /** Orchestrator-curated summary of the dependency's output. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Executor → Orchestrator boundary
// ---------------------------------------------------------------------------

/**
 * What the executor reports back to the orchestrator.
 */
export interface TaskReport {
  taskId: TaskId;
  agentId: AgentId;
  status: "completed" | "failed" | "needs_review";
  /** Raw result from the agent. Only the orchestrator sees this. */
  rawResult: string;
  /** Memories created during execution. */
  memoriesCreated: string[];
  /** If the executor hit a checkpoint and needs orchestrator review. */
  checkpointReason?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint steps (orchestrator consults during execution)
// ---------------------------------------------------------------------------

/**
 * A checkpoint is an explicit pause point in the state machine where
 * the executor yields to the orchestrator for review.
 *
 * Use cases:
 * - After a pure analysis phase, before committing to an effectful action
 * - When the executor is uncertain and wants orchestrator guidance
 * - At natural breakpoints in long-running tasks
 * - Before irreversible operations
 */
export type CheckpointAction =
  | { kind: "continue" }
  | { kind: "modify"; newInstructions: string }
  | { kind: "abort"; reason: string }
  | { kind: "consult_user"; question: string };
