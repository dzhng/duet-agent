import type { TaskId } from "./identity.js";

export interface CommLayer {
  send(message: CommMessage): Promise<void>;
  receive(): Promise<CommMessage>;
  onMessage(handler: (message: CommMessage) => void): () => void;
  sendStatus(status: AgentStatus): Promise<void>;
}

export type CommMessage =
  | { kind: "text"; content: string }
  | { kind: "file"; path: string; mimeType: string }
  | { kind: "structured"; data: Record<string, unknown> }
  | { kind: "error"; message: string };

export type AgentStatus =
  | { kind: "idle" }
  | { kind: "thinking"; description?: string }
  | { kind: "executing"; taskId: TaskId; description?: string }
  | { kind: "waiting"; reason: string };
