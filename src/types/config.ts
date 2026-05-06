import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettingsInput } from "./memory.js";
import type { TurnMode, TurnOptions } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

export interface TurnRunnerConfig extends TurnOptions {
  memory?: ObservationalMemorySettingsInput;
  /**
   * PGlite database directory for durable observational memories.
   * SessionManager defaults this to
   * `.duet/memory.db`; pass `false` to keep memories in process only.
   */
  memoryDbPath?: string | false;
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
  /**
   * Controls filesystem skill discovery. Defaults search both Duet-specific
   * `.duet/skills` and standard `.agents/skills` directories in `cwd` and the
   * user's home directory; set `includeDefaults: false` to rely only on
   * explicit `skills` or `skillPaths`.
   */
  skillDiscovery?: SkillDiscoveryOptions;
}
