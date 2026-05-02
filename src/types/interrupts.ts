import type { AgentId } from "./identity.js";

export type InterruptSource =
  | { kind: "user"; message: string }
  | { kind: "environment"; source: string; payload: string }
  | { kind: "agent"; agentId: AgentId; message: string }
  | { kind: "guardrail"; rule: string; message: string }
  | { kind: "timeout" };

export interface Interrupt {
  id: string;
  timestamp: number;
  source: InterruptSource;
  priority: "pause" | "queue" | "info";
}

export interface InterruptBus {
  emit(interrupt: Omit<Interrupt, "id" | "timestamp">): void;
  on(handler: (interrupt: Interrupt) => void): () => void;
  waitFor(predicate: (interrupt: Interrupt) => boolean, timeoutMs?: number): Promise<Interrupt>;
  drain(): Interrupt[];
}
