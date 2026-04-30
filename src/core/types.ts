/**
 * Core types for duet-agent.
 *
 * The key architectural insight: memories, sandboxes, and interrupts are not
 * optional modules — they're woven into every agent turn. An agent without
 * memory is stateless. An agent without a sandbox can't act. An agent that
 * can't be interrupted can't collaborate.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { Skill, loadSkills } from "@mariozechner/pi-coding-agent";

export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Every entity in the system gets a typed ID. */
export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type MemoryId = string & { readonly __brand: "MemoryId" };

// ---------------------------------------------------------------------------
// Memory (native — not a plugin)
// ---------------------------------------------------------------------------

export type ObservationPriority = "high" | "medium" | "low";
export type ObservationScope = "session" | "resource";
export type ReflectionMode = "none" | "threshold" | "forced";

export type ObservationSource =
  | { kind: "user" }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "system" }
  | { kind: "tool"; toolName: string };

/** A distilled fact from prior conversation, rendered as text for model context. */
export interface Observation {
  id: MemoryId;
  sessionId: SessionId;
  createdAt: number;
  observedDate: string;
  referencedDate?: string;
  relativeDate?: string;
  timeOfDay?: string;
  priority: ObservationPriority;
  scope: ObservationScope;
  source: ObservationSource;
  content: string;
  tags: string[];
}

/** Raw messages are retained until the observer compresses them into observations. */
export interface RawMemoryMessage {
  id: MemoryId;
  sessionId: SessionId;
  createdAt: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  estimatedTokens?: number;
}

export interface BufferedObservationChunk {
  id: MemoryId;
  sessionId: SessionId;
  createdAt: number;
  observations: string;
  messageTokenCount: number;
  observationTokenCount: number;
  messageIds: MemoryId[];
  status: "pending" | "active" | "failed";
}

export interface ObservationBlock {
  sessionId: SessionId;
  observations: Observation[];
  updatedAt: number;
  estimatedTokens?: number;
}

export interface RawMemoryBlock {
  sessionId: SessionId;
  messages: RawMemoryMessage[];
  updatedAt: number;
  estimatedTokens?: number;
}

export interface ObservationalMemorySnapshot {
  sessionId: SessionId;
  observations: ObservationBlock;
  raw: RawMemoryBlock;
  buffered: BufferedObservationChunk[];
}

export interface ObservationalMemorySettings {
  enabled: boolean;
  scope: ObservationScope;
  model?: Model<any>;
  observation: {
    model?: Model<any>;
    messageTokens: number;
    maxTokensPerBatch: number;
    bufferTokens: number | false;
    bufferActivation: number;
    blockAfter?: number;
    previousObserverTokens?: number | false;
    instruction?: string;
    threadTitle?: boolean;
  };
  reflection: {
    model?: Model<any>;
    observationTokens: number;
    bufferActivation: number;
    blockAfter?: number;
    instruction?: string;
  };
  retrieval?: boolean | { vector?: boolean; scope?: ObservationScope };
  shareTokenBudget: boolean;
  temporalMarkers: boolean;
  activateAfterIdle?: number;
  activateOnProviderChange: boolean;
}

export interface ObservationQuery {
  sessionId?: SessionId;
  query?: string;
  tags?: string[];
  scope?: ObservationScope;
  limit?: number;
  minPriority?: ObservationPriority;
}

export type MemoryStoreEvent =
  | { type: "raw_message_appended"; message: RawMemoryMessage }
  | { type: "observation_appended"; observation: Observation }
  | { type: "raw_messages_replaced"; sessionId: SessionId; messages: RawMemoryMessage[] }
  | { type: "observations_replaced"; sessionId: SessionId; observations: Observation[] }
  | { type: "buffered_observation_appended"; chunk: BufferedObservationChunk }
  | { type: "buffered_observations_replaced"; sessionId: SessionId; chunks: BufferedObservationChunk[] };

export type MemoryStoreEventHandler = (event: MemoryStoreEvent) => void;

export interface MemoryStorage {
  on(handler: MemoryStoreEventHandler): () => void;
  appendRawMessage(message: Omit<RawMemoryMessage, "id" | "createdAt">): Promise<RawMemoryMessage>;
  appendObservation(observation: Omit<Observation, "id" | "createdAt">): Promise<Observation>;
  recall(query: ObservationQuery): Promise<Observation[]>;
  getSnapshot(sessionId: SessionId): Promise<ObservationalMemorySnapshot>;
  replaceRawMessages(sessionId: SessionId, messages: RawMemoryMessage[]): Promise<void>;
  replaceObservations(sessionId: SessionId, observations: Observation[]): Promise<void>;
  appendBufferedObservation(chunk: Omit<BufferedObservationChunk, "id" | "createdAt">): Promise<BufferedObservationChunk>;
  replaceBufferedObservations(sessionId: SessionId, chunks: BufferedObservationChunk[]): Promise<void>;
  render(snapshot: ObservationalMemorySnapshot): string;
}

// ---------------------------------------------------------------------------
// Sandbox (native — not a plugin)
// ---------------------------------------------------------------------------

/** Result of a sandbox command execution. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Whether the command was killed (timeout or interrupt). */
  killed: boolean;
}

export interface SandboxOptions {
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in ms. 0 = no timeout. */
  timeoutMs?: number;
  /** If true, stream stdout/stderr to the interrupt bus as they arrive. */
  stream?: boolean;
}

export interface Sandbox {
  /** Execute a bash command. This is the only execution primitive. */
  exec(command: string, options?: SandboxOptions): Promise<ExecResult>;
  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<string>;
  /** Write a file to the sandbox filesystem. */
  writeFile(path: string, content: string): Promise<void>;
  /** List files matching a glob. */
  glob(pattern: string, cwd?: string): Promise<string[]>;
  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;
  /** Tear down the sandbox. */
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Interrupts (native — not a plugin)
// ---------------------------------------------------------------------------

/** The different sources that can interrupt an agent. */
export type InterruptSource =
  | { kind: "user"; message: string }
  | { kind: "environment"; source: string; payload: string }
  | { kind: "agent"; agentId: AgentId; message: string }
  | { kind: "guardrail"; rule: string; message: string }
  | { kind: "timeout" };

export interface Interrupt {
  id: string;
  timestamp: number;
  source: InterruptSource;
  /** Whether this interrupt should pause the current agent turn. */
  priority: "pause" | "queue" | "info";
}

export interface InterruptBus {
  /** Emit an interrupt. */
  emit(interrupt: Omit<Interrupt, "id" | "timestamp">): void;
  /** Subscribe to interrupts. Returns an unsubscribe function. */
  on(handler: (interrupt: Interrupt) => void): () => void;
  /** Wait for the next interrupt matching a predicate. */
  waitFor(predicate: (interrupt: Interrupt) => boolean, timeoutMs?: number): Promise<Interrupt>;
  /** Drain all queued interrupts. */
  drain(): Interrupt[];
}

// ---------------------------------------------------------------------------
// Guardrails (optional but integrated)
// ---------------------------------------------------------------------------

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  /** If not allowed, suggest an alternative action. */
  suggestion?: string;
}

export interface Guardrail {
  name: string;
  description: string;
  /** Evaluate whether an action is allowed. */
  evaluate(context: GuardrailContext): Promise<GuardrailResult>;
}

export interface GuardrailContext {
  /** The agent attempting the action. */
  agentId: AgentId;
  /** What the agent wants to do. */
  action: string;
  /** The full command or content being evaluated. */
  content: string;
  /** Relevant observations for context. */
  memories: Observation[];
  /** Current session state. */
  sessionState: SessionState;
}

// ---------------------------------------------------------------------------
// Session State Machine (the heart of multi-agent orchestration)
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

/**
 * Task purity classification. The orchestrator determines this during planning.
 *
 * - "pure": no side effects — reads files, analyzes code, generates plans.
 *   Pure tasks with satisfied dependencies are auto-parallelized.
 * - "effectful": has side effects — writes to external systems, sends emails,
 *   updates CRM records, modifies infrastructure. Effectful tasks run
 *   sequentially and may require user confirmation.
 */
export type TaskPurity = "pure" | "effectful";

/** A task in the orchestrator's plan. Sub-agents execute tasks. */
export interface Task {
  id: TaskId;
  /** Human-readable description of what needs to be done. */
  description: string;
  /** The dynamically-defined agent spec that should execute this. */
  agentSpec: SubAgentSpec;
  /** Current status. */
  status: TaskStatus;
  /** IDs of tasks that must complete before this one starts. */
  dependencies: TaskId[];
  /**
   * Whether this task is pure (no side effects) or effectful.
   * Pure tasks are auto-parallelized. Effectful tasks run sequentially.
   */
  purity: TaskPurity;
  /** For effectful tasks: what external system is affected. */
  sideEffectDescription?: string;
  /** Result produced by the sub-agent (if completed). */
  result?: string;
  /** Error message (if failed). */
  error?: string;
  /** Memories created during this task's execution. */
  memoriesCreated: MemoryId[];
}

/**
 * The session state machine. The orchestrator creates and modifies this;
 * sub-agents execute tasks and produce state transitions.
 * This is NOT a tool-call graph — it's a living document.
 */
export interface SessionState {
  sessionId: SessionId;
  /** The original user goal. */
  goal: string;
  /** Current phase of execution. */
  phase: "planning" | "executing" | "evaluating" | "complete" | "interrupted";
  /** The task graph. Orchestrator builds this; sub-agents consume it. */
  tasks: Task[];
  /** Global context available to all agents in this session. */
  context: Record<string, unknown>;
  /** Accumulated memories from this session. */
  sessionMemories: MemoryId[];
  /** History of state transitions for debugging/replay. */
  transitions: StateTransition[];
}

export interface StateTransition {
  timestamp: number;
  fromPhase: SessionState["phase"];
  toPhase: SessionState["phase"];
  trigger: string;
  agentId?: AgentId;
  taskId?: TaskId;
}

// ---------------------------------------------------------------------------
// Sub-Agent Specification (dynamically defined by orchestrator)
// ---------------------------------------------------------------------------

/**
 * Sub-agents are not pre-built classes — the orchestrator defines them
 * dynamically based on the task at hand. This spec is all a sub-agent
 * needs to know about itself.
 */
export interface SubAgentSpec {
  /** Unique agent ID for this execution. */
  id: AgentId;
  /** What this agent's role is (e.g., "code-writer", "researcher"). */
  role: string;
  /** System prompt for this agent — written by the orchestrator. */
  instructions: string;
  /** Which model to use. */
  model: Model<any>;
  /** Which tools this agent is allowed to use (subset of sandbox + memory). */
  allowedActions: string[];
  /** Max turns before the agent must yield. */
  maxTurns: number;
  /** Memory scope: what memories this agent can access. */
  memoryAccess: "all" | "session" | "none";
}

// ---------------------------------------------------------------------------
// Communication Layer (decoupled from agent logic)
// ---------------------------------------------------------------------------

/**
 * The comm layer is how the system talks to the user. It's completely
 * decoupled from agent logic — you can swap text chat for voice, video
 * stream analysis, or anything else.
 */
export interface CommLayer {
  /** Send a message to the user. */
  send(message: CommMessage): Promise<void>;
  /** Receive the next message from the user. Blocks until available. */
  receive(): Promise<CommMessage>;
  /** Subscribe to incoming messages. */
  onMessage(handler: (message: CommMessage) => void): () => void;
  /** Signal that the agent is working (typing indicator, etc). */
  sendStatus(status: AgentStatus): Promise<void>;
}

export type CommMessage =
  | { kind: "text"; content: string }
  | { kind: "file"; path: string; mimeType: string }
  | { kind: "structured"; data: Record<string, unknown> }
  | { kind: "error"; message: string };

export type AgentStatus =
  | { kind: "idle" }
  | { kind: "thinking"; description?: string }
  | { kind: "executing"; taskId: TaskId; description?: string }
  | { kind: "waiting"; reason: string };

// ---------------------------------------------------------------------------
// Agent Harness Config
// ---------------------------------------------------------------------------

export interface DuetAgentConfig {
  /** The orchestrator model (should be the smartest available). */
  orchestratorModel: Model<any>;
  /** Default model for sub-agents. Orchestrator can override per-task. */
  defaultSubAgentModel: Model<any>;
  /** Memory store implementation. */
  memory: MemoryStorage;
  /** Observational memory options. Enabled by default with conservative long-context thresholds. */
  observationalMemory?: boolean | Partial<ObservationalMemorySettings>;
  /** Sandbox implementation. */
  sandbox: Sandbox;
  /** Communication layer. */
  comm: CommLayer;
  /** Optional guardrails. */
  guardrails?: Guardrail[];
  /** Max concurrent sub-agents (only applies to pure tasks). */
  maxConcurrency?: number;
  /** Global system instructions prepended to all agents. */
  systemInstructions?: string;
  /** Skills available to all agents. Loaded at init time. */
  skills?: Skill[];
  /** Skill discovery options. Defaults to ~/.agents/skills and <cwd>/.agents/skills. */
  skillDiscovery?: SkillDiscoveryOptions;
  /** Called on every state transition (for logging, UI, etc). */
  onTransition?: (transition: StateTransition, state: SessionState) => void;
  /** Called when an interrupt is received. */
  onInterrupt?: (interrupt: Interrupt) => void;
}
