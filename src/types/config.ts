import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettingsInput } from "./memory.js";
import type { TurnMode, TurnOptions } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

export interface MemoryStorageOptions {
  path: string;
}

export interface TurnRunnerConfig extends TurnOptions {
  memory?: ObservationalMemorySettingsInput;
  memoryStorage?: MemoryStorageOptions;
  cwd?: string;
  /** Default mode for TurnRunner.turn. "auto" lets the runner classify each prompt. */
  mode?: TurnMode;
  guardrails?: GuardrailConfig[];
  systemInstructions?: string;
  /**
   * Files loaded from `cwd` and appended to the base system prompt.
   *
   * Defaults to `["AGENTS.md"]` so repository-local agent guidance is included
   * automatically. Set to `[]` to disable file loading, or provide an explicit
   * ordered list to replace the default.
   */
  systemPromptFiles?: string[];
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
}
