/**
 * duet-agent — An opinionated full-stack agent harness.
 *
 * Native memories. Native sandboxes. Native interrupts. Multi-agent by default.
 * No MCP — everything is files and CLI.
 */

// Core
export type {
  // IDs
  SessionId,
  AgentId,
  TaskId,
  MemoryId,
  // Memory
  Memory,
  MemoryQuery,
  MemoryStore,
  // Sandbox
  ExecResult,
  SandboxOptions,
  Sandbox,
  // Interrupts
  InterruptSource,
  Interrupt,
  InterruptBus,
  // Guardrails
  GuardrailResult,
  Guardrail,
  GuardrailContext,
  // Session state
  TaskStatus,
  TaskPurity,
  Task,
  SessionState,
  StateTransition,
  // Sub-agents
  SubAgentSpec,
  // Communication
  CommLayer,
  CommMessage,
  AgentStatus,
  // Config
  DuetAgentConfig,
} from "./core/types.js";

export { createSessionId, createAgentId, createTaskId, createMemoryId } from "./core/ids.js";

// Memory
export { FileMemoryStore } from "./memory/index.js";
export { setEmbeddingModel } from "./memory/embeddings.js";

// Sandbox
export { LocalSandbox } from "./sandbox/index.js";

// Interrupts
export { InterruptController } from "./interrupt/index.js";

// Orchestrator
export { Orchestrator } from "./orchestrator/index.js";
export { SubAgentRunner } from "./orchestrator/index.js";
export { createTools } from "./orchestrator/index.js";

// Communication
export { StdioComm } from "./comm/index.js";

// Guardrails
export { SemanticGuardrail, PatternGuardrail, createFirewall } from "./guardrails/index.js";

// Skills
export type {
  Skill,
  SkillFile,
  SkillReference,
  SkillRegistry,
  SkillSource,
  SkillDiscoveryOptions,
} from "./skills/index.js";
export { discoverLocal, loadRemote, loadRegistry, discoverAll } from "./skills/index.js";

// Agent templates
export { AGENT_TEMPLATES } from "./agents/index.js";
