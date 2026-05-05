import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettings } from "./memory.js";
import type { TurnMode } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

export interface MemoryStorageOptions {
  path: string;
}

export interface TurnRunnerConfig {
  /** Default model in provider:modelId format, passed through pi-ai's model registry. */
  model: string;
  memory?: Partial<ObservationalMemorySettings>;
  memoryStorage?: MemoryStorageOptions;
  cwd?: string;
  /** Default mode for TurnRunner.turn. "auto" lets the runner classify each prompt. */
  mode?: TurnMode;
  guardrails?: GuardrailConfig[];
  systemInstructions?: string;
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
}
