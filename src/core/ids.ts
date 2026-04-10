import { nanoid } from "nanoid";
import type { AgentId, MemoryId, SessionId, TaskId } from "./types.js";

export const createSessionId = (): SessionId => `ses_${nanoid(12)}` as SessionId;
export const createAgentId = (): AgentId => `agt_${nanoid(12)}` as AgentId;
export const createTaskId = (): TaskId => `tsk_${nanoid(12)}` as TaskId;
export const createMemoryId = (): MemoryId => `mem_${nanoid(12)}` as MemoryId;
