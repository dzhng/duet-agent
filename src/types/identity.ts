import { nanoid } from "nanoid";

/** Typed IDs used across harness state, memory, and todos. */
export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type TodoId = string & { readonly __brand: "TodoId" };
export type MemoryId = string & { readonly __brand: "MemoryId" };

export const createSessionId = (): SessionId => `ses_${nanoid(12)}` as SessionId;
export const createAgentId = (): AgentId => `agt_${nanoid(12)}` as AgentId;
export const createTodoId = (): TodoId => `todo_${nanoid(12)}` as TodoId;
export const createMemoryId = (): MemoryId => `mem_${nanoid(12)}` as MemoryId;
