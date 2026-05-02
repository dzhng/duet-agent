import { nanoid } from "nanoid";

/** Typed IDs used across orchestrator state, memory, and tasks. */
export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type MemoryId = string & { readonly __brand: "MemoryId" };

export const createSessionId = (): SessionId => `ses_${nanoid(12)}` as SessionId;
export const createAgentId = (): AgentId => `agt_${nanoid(12)}` as AgentId;
export const createTaskId = (): TaskId => `tsk_${nanoid(12)}` as TaskId;
export const createMemoryId = (): MemoryId => `mem_${nanoid(12)}` as MemoryId;
