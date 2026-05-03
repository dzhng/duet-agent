import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type AgentRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

/**
 * Serializable state for agent mode.
 *
 * pi-agent-core owns the live in-process Agent instance while a turn is
 * running. This type is the harness-level snapshot that terminal events can
 * return so the layer above the harness can persist enough state to continue a
 * later turn.
 */
export interface AgentRun {
  status: AgentRunStatus;
  messages: AgentMessage[];
}
