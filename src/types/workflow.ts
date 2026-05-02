/**
 * Archon-inspired workflow node parameters.
 *
 * These are descriptive types for workflow ideas we may port into duet-agent:
 * declarative nodes, explicit completion gates, loop signals, retry policy, and
 * persisted execution metadata for resume.
 */

export type WorkflowNodeKind =
  | "action"
  | "agent"
  | "condition"
  | "parallel"
  | "loop"
  | "human"
  | "validation";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting";

export type WorkflowCompletionSignal =
  | { kind: "process_exit"; successCodes?: number[] }
  | { kind: "explicit_signal"; signal: string }
  | { kind: "artifact"; path: string; required?: boolean }
  | { kind: "condition"; expression: string }
  | { kind: "human_approval" };

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  retryOn?: string[];
}

export interface WorkflowNodeParams {
  id: string;
  title?: string;
  description?: string;
  kind: WorkflowNodeKind;
  dependencies?: string[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  artifacts?: string[];
  completion?: WorkflowCompletionSignal;
  timeoutMs?: number;
  retry?: WorkflowRetryPolicy;
  condition?: string;
  loop?: {
    itemSource?: string;
    maxIterations?: number;
    continueSignal?: string;
    breakSignal?: string;
  };
  agent?: {
    role?: string;
    prompt?: string;
    tools?: string[];
    model?: string;
    maxTurns?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface WorkflowNodeExecution {
  nodeId: string;
  status: WorkflowNodeStatus;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  output?: unknown;
  error?: string;
}
