import type { Model } from "@mariozechner/pi-ai";
import type { AgentId } from "./identity.js";
import type { Observation } from "./memory.js";
import type { SessionState } from "./session.js";

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  suggestion?: string;
}

export interface Guardrail {
  name: string;
  description: string;
  evaluate(context: GuardrailContext): Promise<GuardrailResult>;
}

export interface PatternGuardrailRuleConfig {
  pattern: RegExp;
  action: "block" | "warn";
  reason: string;
}

/** Extra guardrail policies layered on top of the harness defaults. */
export type GuardrailConfig =
  | { kind: "pattern"; rules: PatternGuardrailRuleConfig[] }
  | { kind: "semantic"; model: Model<any>; policy: string };

export interface GuardrailContext {
  agentId: AgentId;
  action: string;
  content: string;
  memories: Observation[];
  sessionState: SessionState;
}
