import type { Model } from "@mariozechner/pi-ai";
import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type {
  MemoryPersistenceModule,
  ObservationalMemorySettings,
  ObservationalMemorySnapshot,
  RawMemoryMessage,
} from "./memory.js";
import type { OrchestratorMode, OrchestratorRun } from "./protocol.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

/** Runtime continuation input for resuming or routing an orchestration run. */
export interface OrchestratorRunOptions {
  /** Overrides the config default for this run. */
  mode?: OrchestratorMode;
  run?: OrchestratorRun;
  memory?: Partial<ObservationalMemorySnapshot>;
  messages?: RawMemoryMessage[];
}

export interface DuetAgentConfig {
  orchestratorModel: Model<any>;
  memory?: Partial<ObservationalMemorySettings>;
  memoryPersistence?: MemoryPersistenceModule[];
  cwd?: string;
  /** Default mode for Orchestrator.run. "auto" lets the orchestrator classify each prompt. */
  mode?: OrchestratorMode;
  guardrails?: GuardrailConfig[];
  maxConcurrency?: number;
  systemInstructions?: string;
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
}
