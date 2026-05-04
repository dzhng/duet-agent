import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettings } from "./memory.js";
import type { HarnessMode } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

export interface MemoryStorageOptions {
  path: string;
}

export interface HarnessConfig {
  /** Default model in provider:modelId format, passed through pi-ai's model registry. */
  harnessModel: string;
  memory?: Partial<ObservationalMemorySettings>;
  memoryStorage?: MemoryStorageOptions;
  cwd?: string;
  /** Default mode for Harness.turn. "auto" lets the harness classify each prompt. */
  mode?: HarnessMode;
  guardrails?: GuardrailConfig[];
  systemInstructions?: string;
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
}
