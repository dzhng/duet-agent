import type { Model } from "@mariozechner/pi-ai";
import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";
import type { CommLayer } from "./comm.js";
import type { GuardrailConfig } from "./guardrails.js";
import type { Interrupt } from "./interrupts.js";
import type {
  MemoryPersistenceModule,
  ObservationalMemorySettings,
  ObservationalMemorySnapshot,
  RawMemoryMessage,
} from "./memory.js";
import type { SessionState, StateTransition } from "./session.js";

/** Directly mirrors pi-coding-agent's loadSkills options. */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

/** Runtime continuation input for resuming an orchestration state machine. */
export interface OrchestratorRunOptions {
  state?: SessionState;
  memory?: Partial<ObservationalMemorySnapshot>;
  messages?: RawMemoryMessage[];
  resume?: "auto" | "plan" | "execute" | "evaluate";
}

export interface DuetAgentConfig {
  orchestratorModel: Model<any>;
  defaultSubAgentModel: Model<any>;
  memory?: Partial<ObservationalMemorySettings>;
  memoryPersistence?: MemoryPersistenceModule[];
  cwd?: string;
  comm: CommLayer;
  guardrails?: GuardrailConfig[];
  maxConcurrency?: number;
  systemInstructions?: string;
  skills?: Skill[];
  skillDiscovery?: SkillDiscoveryOptions;
  onTransition?: (transition: StateTransition, state: SessionState) => void;
  onInterrupt?: (interrupt: Interrupt) => void;
}
