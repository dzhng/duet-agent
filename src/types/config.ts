import type { Model } from "@mariozechner/pi-ai";
import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type {
  MemoryPersistenceModule,
  ObservationalMemorySettings,
  ObservationalMemorySnapshot,
  RawMemoryMessage,
} from "./memory.js";
import type { HarnessMode, HarnessRun } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

/** Runtime continuation input for resuming or routing an orchestration run. */
export interface HarnessRunOptions {
  /** Overrides the config default for this run. */
  mode?: HarnessMode;
  run?: HarnessRun;
  memory?: Partial<ObservationalMemorySnapshot>;
  messages?: RawMemoryMessage[];
}

export interface DuetAgentConfig {
  harnessModel: Model<any>;
  memory?: Partial<ObservationalMemorySettings>;
  memoryPersistence?: MemoryPersistenceModule[];
  cwd?: string;
  /** Default mode for Harness.run. "auto" lets the harness classify each prompt. */
  mode?: HarnessMode;
  guardrails?: GuardrailConfig[];
  maxConcurrency?: number;
  systemInstructions?: string;
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
}
