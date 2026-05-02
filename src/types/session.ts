import type { Model } from "@mariozechner/pi-ai";
import type { AgentId, MemoryId, SessionId, TaskId } from "./identity.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";
export type TaskPurity = "pure" | "effectful";

export interface Task {
  id: TaskId;
  description: string;
  agentSpec: SubAgentSpec;
  status: TaskStatus;
  dependencies: TaskId[];
  purity: TaskPurity;
  sideEffectDescription?: string;
  result?: string;
  error?: string;
  memoriesCreated: MemoryId[];
}

export interface SessionState {
  sessionId: SessionId;
  goal: string;
  phase: "planning" | "executing" | "evaluating" | "complete" | "interrupted";
  tasks: Task[];
  context: Record<string, unknown>;
  sessionMemories: MemoryId[];
  transitions: StateTransition[];
}

export interface StateTransition {
  timestamp: number;
  fromPhase: SessionState["phase"];
  toPhase: SessionState["phase"];
  trigger: string;
  agentId?: AgentId;
  taskId?: TaskId;
}

export interface SubAgentSpec {
  id: AgentId;
  role: string;
  instructions: string;
  model: Model<any>;
  allowedActions: string[];
  maxTurns: number;
  memoryAccess: "all" | "session" | "none";
}
