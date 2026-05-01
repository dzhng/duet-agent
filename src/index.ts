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
  ObservationPriority,
  ObservationScope,
  ReflectionMode,
  ObservationSource,
  Observation,
  RawMemoryMessage,
  BufferedObservationChunk,
  ObservationBlock,
  RawMemoryBlock,
  ObservationalMemorySnapshot,
  ObservationalMemorySettings,
  ObservationQuery,
  MemoryStoreEvent,
  MemoryStoreEventHandler,
  MemoryPersistenceModule,
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

// Layer boundaries
export type {
  StateSnapshot,
  TaskSummary,
  CommToOrchestrator,
  OrchestratorToComm,
  TaskContext,
  DependencyResult,
  TaskReport,
  CheckpointAction,
} from "./core/layers.js";

// Layer bridges
export { CommOrchestratorBridge, buildTaskContext } from "./core/bridges.js";

// Memory
export {
  MemoryStore,
  OBSERVATIONAL_MEMORY_DEFAULTS,
  OBSERVATION_CONTINUATION_HINT,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVER_GUIDELINES,
  ModelByInputTokens,
  resolveObservationalMemorySettings,
  validateObservationalMemorySettings,
  createObservationalMemoryTransform,
  buildObserverOutputFormat,
  buildObserverSystemPrompt,
  buildObserverPrompt,
  formatMessagesForObserver,
  parseObserverOutput,
  optimizeObservationsForContext,
  sanitizeObservationLines,
  detectDegenerateRepetition,
  generateAnchorId,
  wrapInObservationGroup,
  parseObservationGroups,
  stripObservationGroups,
  combineObservationGroupRanges,
  renderObservationGroupsForReflection,
  deriveObservationGroupProvenance,
  reconcileObservationGroupsFromReflection,
} from "./memory/index.js";
export type {
  ObserverResult,
  ReflectorResult,
  ModelByInputTokensConfig,
  ObservationalMemoryTransformOptions,
  ObservationGroup,
} from "./memory/index.js";

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

// Agent templates
export { AGENT_TEMPLATES } from "./agents/index.js";
