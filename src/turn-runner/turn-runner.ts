import { resolve } from "node:path";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import { resolveProviderApiKey } from "../model-resolution/duet-gateway.js";
import { ensureFreshConnectedTokens } from "../connected-providers/tokens.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";
import { stripSystemReminders, systemReminder } from "../lib/system-reminder.js";

import { assistantText } from "../core/serializer.js";
import { classifyRoute } from "../model-routing/classifier.js";
import type { ClassifyRouteOptions } from "../model-routing/classifier.js";
import { loadRoutingTable } from "../model-routing/loader.js";
import { AdvisorTurnLifecycle } from "../model-routing/advisor-lifecycle.js";
import {
  ADVISOR_COMPLETION_REVIEW_REMINDER,
  ADVISOR_EXECUTOR_GUIDANCE_LAYER,
  ADVISOR_ORIENTATION_REMINDER,
} from "../model-routing/prompts.js";
import {
  ADVISOR_RECENT_MESSAGE_TARGET_TOKENS,
  buildAdvisorContext,
  captureAdvisorExecutorContext,
  type AdvisorExecutorContext,
} from "../model-routing/advisor-context.js";
import { ADVISOR_MAX_OUTPUT_TOKENS } from "../model-routing/advisor.js";
import { resolveTierDefault, type RouteResolutionCatalog } from "../model-routing/resolve.js";
import type { StepObservation } from "../model-routing/step-triggers.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouterStatus,
  type RouterSwitch,
} from "../model-routing/router.js";
import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type AdvisorPolicy,
  type RoutingTable,
} from "../model-routing/table.js";
import { toXML } from "../lib/xml.js";
import {
  compactObservationalContext,
  createObservationalContextTransform,
  DEFAULT_EFFECTIVE_CONTEXT,
  estimateTokens,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
  updateObservationalMemory,
} from "../memory/observational.js";
import { rebuildMemoryContextPack, rebuildPinnedStoreContextPack } from "../memory/context-pack.js";
import { createEmbeddingClient } from "../memory/embedding.js";
import {
  loadStoredMemory,
  replaceSessionObservations,
  type MemoryPersistenceHandle,
} from "../memory/storage.js";
import { MemoryContextCache } from "../memory/store.js";
import { discoverMemoryStores } from "../memory/store/discovery.js";
import {
  DEFAULT_CLI_MEMORY_MODEL,
  DEFAULT_CLI_MODEL,
  resolveModelName,
  routingCatalogAdapter,
} from "../model-resolution/resolver.js";
import { DEFAULT_TASK_WAIT_BUDGET_MS, type TurnRunnerConfig } from "../types/config.js";
import {
  COMPACT_MESSAGE_TOKENS_RATIO,
  compactTurnState,
  type AutoStateCompactionOptions,
} from "./state-compaction.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnContextWindowUsage,
  WireGuardHorizon,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnEventOrigin,
  TurnFollowUpQueueEntry,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
  TurnPromptImage,
  TurnQuestion,
  TurnState,
  TurnTokenUsage,
  ModelUsageEntry,
  TurnStartCommand,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnTodo,
} from "../types/protocol.js";
import type { StateMachineAgentState } from "../types/state-machine.js";
import { createAgentEventTranslator, agentMessageText } from "./agent-events.js";
import {
  createRecallMemorySystemPromptLayer,
  createSourceOfTruthSystemPromptLayer,
  createStateMachineSystemPromptLayer,
  withheldAskReminder,
  parkNudge,
} from "./prompts.js";
import {
  applyEvictionHorizon,
  calculateWireTokens,
  createInitialHorizon,
  findEvictionHorizon,
} from "./wire-shaping.js";
import {
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  resolveStateCwd,
  formatCarriedTodosReminder,
  formatStateMachineTerminalAcknowledgmentPrompt,
  type AskAdvisorToolStorage,
  type RecallMemoryToolStorage,
  isTurnRunnerControlResult,
  type TurnRunnerControlResult,
  type StateMachineRunnerDecision,
  MINIMUM_STATE_MACHINE_DELAY_MS,
} from "./tools.js";
import { connectMcpServers, type McpRuntime } from "./mcp.js";
import { SkillContext } from "./skill-context.js";
import { currentParkState, currentScheduledState } from "./state-machine-session.js";
import {
  failActiveSession,
  markTerminalAcknowledged,
  planDecision,
  planWake,
  recordPlannedTerminal,
  recordScheduled,
  recordSettled,
  repeatedSelectionLoopCount,
  startSession as startStateMachineSession,
  supersede,
  type PlannedWork,
  type PollPolicy,
  type ShellSettlement,
  type ShellSpec,
  type SettledDecision,
} from "./state-machine-decisions.js";
import {
  createSubagentExecutor,
  classifySpawnModel,
  type SubagentResult,
  type SubagentAgentConfigInput,
  type SubagentExecutionContext,
  type SubagentRun,
  type SubagentSpec,
} from "./subagent.js";
import { completeTurn, copyOptionalArray, createInitialTurnState } from "./turn-state.js";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
  type TransientRetryPolicy,
} from "./transient-error.js";
import { addUsage, addUsageByModel, usageFromAiSdk } from "./usage-accounting.js";
import { SystemRuntimeClock, type RuntimeClock } from "./runtime-clock.js";
import { createTaskManager, type TaskManager } from "../tasks/task-manager.js";
import type { ScopeId, TaskEvent, TaskId, TaskSettlement, TaskSnapshot } from "../tasks/types.js";
import { createShellStateHandle, type ShellStateHandle } from "./shell-state-handle.js";
import type { StateMachineSession } from "../types/state-machine.js";
import {
  createSpawnAgentTool,
  createTaskAdminTools,
  lostTaskRecoveryReminder,
  settlementNotice,
  wrapBackgroundable,
} from "./task-tools.js";

/** @internal Constructor-only lifecycle seams; these are deliberately absent from config. */
interface TurnRunnerDependencies {
  /** Internal wall-clock seam for deterministic task and schedule lifecycle tests. */
  clock?: RuntimeClock;
  /** Internal schedule-validation override; production keeps the 30-second floor. */
  minimumScheduledDelayMs?: number;
}

interface ChildToolContext {
  /** Scope that owns tasks created by this child. */
  ownerScopeId: ScopeId;
  /** Session identity used by recall_memory. */
  memorySessionId?: string;
  /** Live caller transcript used by recursive fork_context spawns. */
  forkSource: NonNullable<SubagentExecutionContext["forkSource"]>;
  /** Concrete setting of the child that owns this recursively callable toolset. */
  modelSetting(): string;
}

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  /** Internal loop passes continue the same public turn and must retain router facts. */
  continuation?: boolean;
  /**
   * Optional image attachments forwarded to `agent.prompt(text, images)`.
   * Only the parent prompt path carries images; state-machine sub-agents and
   * answer commands ignore them because their prompts are runner-synthesized.
   */
  images?: ImageContent[];
}

export interface AgentConfigInput extends SubagentAgentConfigInput {
  /** Parent boot router used to select the initial concrete model and effort. */
  router?: ModelRouter;
  /** Installs the parent routing hook even when boot starts from a concrete selection. */
  parentModelRouting?: boolean;
}

/**
 * Internal outcome of a single `runAgentWorker` call. Narrower than the
 * public `TurnTerminalEvent`: a worker only produces `complete` or
 * `interrupted`. `ask` is synthesized later from `control`; `sleep` is
 * synthesized by the task-backed turn loop.
 */
export type AgentWorkerOutcome =
  | {
      type: "complete";
      status: "completed" | "failed";
      result?: string;
      error?: string;
      state: TurnState;
    }
  | { type: "interrupted"; state: TurnState };

export interface AgentWorkerResult {
  outcome: AgentWorkerOutcome;
  control: TurnRunnerControlResult;
  /**
   * Usage a stubbed worker fabricated for this parent call. A real parent run
   * never sets this: it streams each completion's usage from the live `Agent`'s
   * `message_end` events, so the aggregate is already recorded by the time the
   * worker returns. Test harnesses that bypass the real `Agent` report usage
   * here and record it themselves (see `TestTurnRunner.runAgentWorker`), which
   * is why production carries no boundary-level usage accounting.
   */
  parentUsage?: TurnTokenUsage;
}

export type ParentLoopInput =
  | {
      type: "user_command";
      command: TurnPromptCommand | TurnAnswerCommand;
      continuation?: boolean;
    }
  | { type: "task_settlements"; settlements: TaskSettlement[] }
  | { type: "transition_enforcement"; stateName: string; output?: unknown }
  | { type: "terminal_acknowledgment" }
  | { type: "wake"; queued?: boolean };

/** Runner-owned continuation that never crosses the public command or event protocol. */
type PendingParentLoopInput = ParentLoopInput | { type: "advisor_completion_review" };

type StateTaskMetadata =
  | { kind: "agent"; stateName: string; run?: SubagentRun }
  | {
      kind: "script" | "poll";
      stateName: string;
      shell: ShellStateHandle;
      pollPolicy?: PollPolicy;
    };

/**
 * How many times the parent is re-prompted to emit the
 * select_state_machine_state it owes after a state completes before the runner
 * gives up and records an `error` terminal. Bounds the protocol-violation retry
 * loop so a parent that never transitions can't spin forever.
 */
const PARENT_TRANSITION_RETRY_BUDGET = 3;

/** Order matches `TurnContextWindowUsage` fields; indexes map to `scaled[0..3]`. */
const CONTEXT_USAGE_KEYS = [
  "systemPrompt",
  "messages",
  "localMemory",
  "globalMemory",
] as const satisfies readonly (keyof TurnContextWindowUsage)[];

/**
 * Rescale the four segment estimates so they sum exactly to the
 * provider-reported `totalTokens` on the latest assistant message.
 * When `totalTokens` is at least the number of non-zero raw slices, each
 * such slice gets at least one token, then the rest is split by raw
 * weight with largest-remainder tie-breaks so the total is exact.
 * Otherwise proportional floors apply (some slices may be zero). When
 * every raw slice is zero, everything is attributed to `messages`.
 */
export function scaleContextWindowUsageToTotalTokens(
  base: TurnContextWindowUsage,
  totalTokens: number,
): TurnContextWindowUsage {
  const target = Math.max(0, Math.floor(totalTokens));
  if (target === 0) {
    return { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 };
  }

  const raw = CONTEXT_USAGE_KEYS.map((k) => Math.max(0, Math.floor(base[k])));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return { systemPrompt: 0, messages: target, localMemory: 0, globalMemory: 0 };
  }

  const minAlloc: number[] = raw.map((v) => (v > 0 ? 1 : 0));
  const minSum = minAlloc.reduce((a, b) => a + b, 0);

  let scaled: number[];
  if (target >= minSum && minSum > 0) {
    // Reserve one token per non-empty raw slice so tiny provider totals
    // do not wipe whole segments in the UI, then split the rest by weight.
    scaled = [...minAlloc];
    const remainderPool = target - minSum;
    if (remainderPool > 0) {
      const extra = raw.map((v) => Math.floor((v * remainderPool) / sum));
      for (let i = 0; i < 4; i++) scaled[i]! += extra[i]!;
      let remainder = remainderPool - extra.reduce((a, b) => a + b, 0);
      const fracs = raw.map((v, i) => ({
        i,
        frac: (v * remainderPool) / sum - extra[i]!,
      }));
      fracs.sort((a, b) => b.frac - a.frac);
      for (let r = 0; r < remainder; r++) {
        scaled[fracs[r]!.i]! += 1;
      }
    }
  } else {
    // Provider total smaller than the number of non-empty slices — fall
    // back to pure proportional floors (some segments may be zero).
    scaled = raw.map((v) => Math.floor((v * target) / sum));
    let remainder = target - scaled.reduce((a, b) => a + b, 0);
    const fracs = raw.map((v, i) => ({
      i,
      frac: (v * target) / sum - scaled[i]!,
    }));
    fracs.sort((a, b) => b.frac - a.frac);
    for (let r = 0; r < remainder; r++) {
      scaled[fracs[r]!.i]! += 1;
    }
  }

  return {
    systemPrompt: scaled[0]!,
    messages: scaled[1]!,
    localMemory: scaled[2]!,
    globalMemory: scaled[3]!,
  };
}

function emptyTokenUsage(): TurnTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export class TurnRunner {
  private readonly eventHandlers = new Set<TurnEventHandler>();
  /** Maps pi agent events to turn steps; stateful so the canonical `tool_call` step can echo the call's input. */
  private readonly agentEventToTurnEvents = createAgentEventTranslator();
  /** In-memory observation store used by context transforms during agent turns. */
  protected readonly memory = new MemoryContextCache();
  /** Hydrates, flushes, and disposes durable observation storage. */
  private memoryPersistence?: MemoryPersistenceHandle;
  /**
   * Session-scoped parent pi agent. It is created once during start() so model,
   * tools, and system prompt shape stay stable for prompt caching while the
   * transcript grows across every pi-agent turn in this duet-agent session.
   */
  private parentAgent?: Agent;
  /** Virtual-model policy owner for the parent session, retained while a concrete pin suspends it. */
  protected modelRouter?: ModelRouter;
  /** Validated project routing table used by parent retargets and explicit virtual state models. */
  private routingTable?: RoutingTable;
  /** Model selection queued while a parent turn is running; applied at the next turn boundary. */
  private pendingModelSelection?: string;
  /** Advisor target and transcript budget selected with the current virtual tier. */
  private advisorPolicy?: AdvisorPolicy;
  /** Product-owned early/final consultation checkpoints for the active public agent-mode turn. */
  private advisorTurnLifecycle?: AdvisorTurnLifecycle;
  /** True only while the parent pi agent is actively producing the public terminal event. */
  private parentAgentRunning = false;
  /** Control results captured during the current parent pass. More than one is a protocol error. */
  private readonly parentControlResults: TurnRunnerControlResult[] = [];
  /** Durable state-machine policy ledger; execution lives in TaskManager. */
  private stateMachine?: StateMachineSession;
  /** Runtime owner for every state execution and scheduled wake. */
  /** Protected for test probes (task descriptors, scope injection); production owner is the loop. */
  protected readonly taskManager: TaskManager;
  /** Execution-only metadata keyed by TaskManager's stable task id. */
  private readonly stateTasks = new Map<TaskId, StateTaskMetadata>();
  /** One-shot context attached to the first real parent pass after lost-task recovery. */
  private recoveredTaskReminder?: string;
  /** Ask withheld by the quiescence gate; re-surfaced on the parent's next pass. */
  private withheldAskQuestions?: TurnQuestion[];
  /** Legacy persisted user-lane projection retained until the next loop owns it. */
  private hydratedQueuedCommands?: TurnCommand[];
  /** Inputs waiting for the single parent slot between sequential passes. */
  private readonly parentInputs: PendingParentLoopInput[] = [];
  /** Wakes the loop when a user command arrives while task work is in process. */
  private readonly parentInputWaiters = new Set<() => void>();
  /** Settlements already folded into the ledger during replacement/interrupt. */
  private readonly ignoredTaskSettlements = new Set<TaskId>();
  /** Delivery posture for task-backed foreground bash calls. */
  private readonly taskSettlementDelivery = new Map<
    TaskId,
    "foreground_pending" | "deliver" | "suppress"
  >();
  /** Coalesces same-tick settlements into one FIFO drain and one B3 notice. */
  private settlementDeliveryQueued = false;
  /** Monotonic root-scope suffix; each public turn owns one root scope. */
  private nextRootScope = 1;
  /** Scope currently accepting state tasks. */
  private activeRootScopeId?: `turn-${number}`;
  /** Tools are built once at the public-turn boundary and reused by every parent pass. */
  private turnTools?: AgentTool[];
  /** Set by interrupt so the loop's sole exit can short-circuit pending-work computation. */
  private interruptReason?: string;
  /** Full task/process unwind started by interrupt(), awaited before its terminal. */
  private interruptCleanup?: Promise<void>;
  /** Guards the single public terminal emission for the active turn. */
  private terminalEmitted = false;
  /** Shared construction path for relay agent states and spawned children. */
  private readonly subagentExecutor: ReturnType<typeof createSubagentExecutor>;
  /**
   * Set true by `interrupt()` while a parent-agent prompt is in flight, so
   * `runAgentWorker` can tell our own abort apart from a real provider error
   * after `agent.prompt()` rejects. The interrupted `TurnState` itself lives
   * on `this.state` (written by `interrupt()` before aborting); this flag is
   * just the discriminator. Reset at the start of each `runAgentWorker`.
   */
  private parentAgentInterrupted = false;
  /**
   * Active work-chain promise. Callers may call turn() repeatedly while this is
   * set; those commands are folded into the same duet-agent turn. A duet-agent
   * turn may contain multiple parent pi-agent turns and multiple state-machine
   * transitions, but it emits one public terminal event for the whole chain.
   */
  private activeTurnPromise?: Promise<TurnTerminalEvent>;
  /**
   * In-flight `compact()` promise, published while the drain + horizon
   * advance is running so concurrent `turn()` calls can serialize behind
   * it. Compact has no `activeTurnPromise` (it does not start a turn
   * chain), so this is the only signal a fire-and-forget caller (e.g. the
   * TUI `/compact` slash command followed immediately by a prompt) has
   * that the wire-shaping horizon is mid-advance.
   */
  private compactInFlight?: Promise<void>;
  /** Latest runner-owned state, hydrated by start() and advanced by terminal events. */
  private state?: TurnState;
  /** True after `start()` has emitted the initial `turn_started` event. */
  private started = false;
  /** Aggregates model usage across parent agents, state agents, and memory work for one turn chain. */
  private turnUsage?: TurnTokenUsage;
  /** Per-model partition of `turnUsage`; reset and populated in lockstep with it via `recordUsage`. */
  private turnUsageByModel?: ModelUsageEntry[];
  /**
   * Snapshot of the latest parent assistant `message_end`'s bar fields.
   * State-agent and terminal emissions reuse these so the bar/breakdown
   * does not jitter mid-turn when only a state agent advanced cost.
   *
   * Always set by the time a state agent runs in production: the parent
   * worker selects a state via a real LLM call, which emits `message_end`
   * and populates this. Exposed as `protected` for test harnesses that
   * stub `runAgentWorker` past the real parent path and need to seed the
   * snapshot before driving a state-agent emission.
   */
  protected lastParentUsageSnapshot?: {
    effectiveContextWindow: number;
    contextWindowUsage: TurnContextWindowUsage;
    lastMessageUsage: TurnTokenUsage;
  };
  /** Ensures persisted memory hydrates once before the first turn that needs it. */
  private memoryLoaded = false;
  /** MCP servers connected during start(). Disposed on runner.dispose(). */
  private mcpRuntime?: McpRuntime;
  protected readonly skillContext: SkillContext;
  protected readonly clock: RuntimeClock;
  protected readonly minimumScheduledDelayMs: number;
  /** Foreground expiry yields a still-running result without cancelling the task. */
  protected readonly taskWaitBudgetMs: number;

  constructor(
    readonly config: TurnRunnerConfig,
    dependencies: TurnRunnerDependencies = {},
  ) {
    this.clock = dependencies.clock ?? new SystemRuntimeClock();
    this.minimumScheduledDelayMs =
      dependencies.minimumScheduledDelayMs ?? MINIMUM_STATE_MACHINE_DELAY_MS;
    this.taskWaitBudgetMs = config.taskWaitBudgetMs ?? DEFAULT_TASK_WAIT_BUDGET_MS;
    this.skillContext = new SkillContext(config);
    this.taskManager = createTaskManager({
      clock: this.clock,
      onEvent: (event) => this.handleTaskEvent(event),
    });
    this.subagentExecutor = createSubagentExecutor({
      createAgent: (input, onControlResult) => this.createAgent(input, onControlResult),
      skillContext: {
        resolveSkills: (spec, ctx) =>
          this.skillContext.resolveSubagentSkills(
            spec.allowedSkills,
            ctx.machineContext ? `state "${ctx.machineContext.currentState}"` : "sub-agent",
          ),
        resolveSlashSkillPrompt: (prompt, skills) =>
          this.skillContext.resolveSlashSkillPrompt(prompt, skills),
        createSystemPromptWithAppendedLayers: (input) =>
          this.createBaseSystemPromptWithAppendedLayers(input),
      },
      inheritedOptions: () => this.resolveSubagentInheritedOptions(),
      resolveModel: (model) => this.resolveStateModel(model),
      seedMessages: (spec, ctx) =>
        spec.forkContext
          ? [...(ctx.forkSource?.messages() ?? this.parentAgent?.state.messages ?? [])]
          : [],
      parentSystemPrompt: (ctx) =>
        ctx.forkSource?.systemPrompt() ?? this.parentAgent?.state.systemPrompt,
      createTools: (cwd, ctx) =>
        this.createTools(
          "agent",
          cwd,
          false,
          ctx.childScopeId && ctx.ownerScopeId
            ? {
                ownerScopeId: ctx.childScopeId,
                ...(ctx.memoryContext?.sessionId
                  ? { memorySessionId: ctx.memoryContext.sessionId }
                  : {}),
                forkSource: {
                  messages: () => [...(ctx.agent?.state.messages ?? [])],
                  systemPrompt: () => ctx.agent?.state.systemPrompt,
                },
                modelSetting: () => {
                  const model = ctx.agent?.state.model;
                  return model ? `${model.provider}:${model.id}` : DEFAULT_CLI_MODEL;
                },
              }
            : undefined,
        ),
      retryTransientServerErrors: (agent) => this.retryTransientServerErrors(agent),
      emitAgentEvent: (event, origin) => this.emitAgentEvent(event, origin),
      recordUsage: (usage, modelId) => this.recordUsage(usage, modelId),
      emitTurnUsage: (origin) => this.emitTurnUsage(origin),
    });
  }

  async dispose(): Promise<void> {
    this.parentAgent?.clearAllQueues();
    this.parentInputs.length = 0;
    this.clearFollowUpQueue();
    await this.taskManager.interruptAll("Runner disposed.");
    await this.taskManager.reapAll("Runner disposed.");
    await this.memoryPersistence?.dispose();
    this.memoryPersistence = undefined;
    await this.mcpRuntime?.dispose();
    this.mcpRuntime = undefined;
  }

  subscribe(handler: TurnEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.requireStarted();
    this.replaceFollowUpQueue(command.prompts);
  }

  /**
   * Compact the runner's wire-visible message tail on demand by advancing
   * the sticky `wireGuardHorizon` so the next request to the actor model
   * dispatches a smaller prompt.
   *
   * Critical: this does **not** mutate `state.agent.messages` or the live
   * parent agent's transcript. The durable transcript is the source of
   * truth for resume, snapshotting, observer/reflector passes, and the
   * TUI scrollback; destroying it would lose information the wire-shaping
   * pipeline is specifically designed to preserve. Instead this reuses
   * the same horizon-advance mechanism that
   * `createObservationalContextTransform` runs every turn — it just
   * forces it now, against a tighter token target than the automatic
   * trigger uses.
   *
   * Target selection:
   *  - When the current wire-tail tokens exceed
   *    `COMPACT_MESSAGE_TOKENS_RATIO` (20%) of the parent agent's
   *    effective context window, the target is that 20% ceiling —
   *    leaving 80% headroom for system prompt, memory packs, the next
   *    user prompt, and the next assistant response.
   *  - When the wire-tail is already under 20%, the target halves the
   *    current wire-tail tokens instead. `compact` is user-initiated, so
   *    even an already-light session must produce visible relief.
   *
   * On a successful horizon advance the memory context pack is refreshed
   * (same fire-and-forget call the transform's `onCompaction` handler
   * uses) so the rendered prefix lines up with the new horizon and the
   * next prompt-cache fault is paid once instead of twice.
   *
   * Rejected with a soft warning while a parent pass is dispatching or while
   * the turn loop is active without an in-process task. A running task opens
   * the parent-idle window: its transcript is isolated from the parent wire
   * horizon, so compact may safely advance that horizon between passes.
   */
  async compact(): Promise<void> {
    this.requireStarted();
    // Parent work owns the wire transcript and therefore closes the gate.
    // In-process state work leaves the parent idle and opens it; scheduled
    // waits have already settled the public turn and are open as well.
    if (
      this.parentAgentRunning ||
      (this.activeTurnPromise && this.taskManager.pendingWork().kind !== "open") ||
      this.compactInFlight
    ) {
      this.emit({
        type: "system",
        level: "warn",
        message: this.compactInFlight
          ? "compact ignored: a compact pass is already in progress."
          : "compact ignored: a parent pass is in flight; retry in the parent-idle window.",
      });
      return;
    }
    // Publish the compact promise so concurrent `turn()` calls observe
    // it and serialize behind us. Fire-and-forget callers (e.g. the TUI
    // `/compact` slash command) would otherwise let a follow-up prompt
    // dispatch with the pre-compact wire-tail and race the horizon
    // mutation. The promise resolves to `void` after the inner body
    // finishes, so `turn()` only needs to await, not inspect a result.
    const inFlight = this.runCompact();
    this.compactInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.compactInFlight === inFlight) {
        this.compactInFlight = undefined;
      }
    }
  }

  private async runCompact(): Promise<void> {
    try {
      const state = this.requireRunnerState();
      const observable = stripObservationalContextMessages(state.agent.messages);
      const previousHorizon = this.wireGuardHorizon.evictionHorizon;
      const currentRetained = applyEvictionHorizon(observable, previousHorizon);
      const beforeTokens = calculateWireTokens(currentRetained);
      const contextWindow = this.effectiveContextWindow();
      const ceiling = Math.max(1, Math.floor(contextWindow * COMPACT_MESSAGE_TOKENS_RATIO));
      const overCeiling = beforeTokens > ceiling;
      const target = overCeiling ? ceiling : Math.max(1, Math.floor(beforeTokens / 2));
      const targetLabel = overCeiling
        ? `target ${target} = 20% of ${contextWindow}`
        : `target ${target} = 50% of current ${beforeTokens}`;
      // Preserve the unobserved tail before the horizon walks past it.
      await this.ensureMemoryCoverageForCompaction(observable);
      const newHorizon = findEvictionHorizon(
        observable,
        previousHorizon,
        (candidate) => calculateWireTokens(candidate) <= target,
      );
      if (newHorizon === previousHorizon) {
        this.emit({
          type: "system",
          level: "info",
          message: `compact: nothing to evict (wire-tail ~${beforeTokens} tokens; ${targetLabel}).`,
        });
        return;
      }
      this.wireGuardHorizon.evictionHorizon = newHorizon;
      this.modelRouter?.noteCompaction();
      const retainedAfter = applyEvictionHorizon(observable, newHorizon);
      const afterTokens = calculateWireTokens(retainedAfter);
      const dropped = currentRetained.length - retainedAfter.length;
      this.emit({
        type: "system",
        level: "info",
        message: `compact: dropped ${dropped} older wire message(s); wire-tail ~${beforeTokens} → ~${afterTokens} tokens (${targetLabel}).`,
      });
      // Refresh the sidebar's context bar so the breakdown reflects the
      // new horizon immediately rather than waiting for the next parent
      // `message_end` to re-anchor `lastMessageUsage`. Without this the
      // bar keeps showing the pre-compact `184k / 200k` slice even though
      // the next request will dispatch a much smaller wire tail.
      this.emitPostCompactUsage();
    } catch (error) {
      // The drain and pack-refresh have their own try/catch; this outer
      // catch guards against an unexpected throw in the horizon-advance
      // path so `runCompact` always settles cleanly and `compactInFlight`
      // resets via the caller's finally.
      this.emit({
        type: "system",
        level: "warn",
        message: `compact: failed (${truncateForSystemMessage(
          error instanceof Error ? error.message : String(error),
        )}).`,
      });
    }
  }

  /**
   * Set up a session before any turn runs. Loads memory and skills, then
   * emits `turn_started` with the initial state (a fresh state, or the
   * resumed state when `command.state` is provided). No agent work runs.
   *
   * Callers (CLI/TUI/session managers) call this once on launch so the user
   * sees available skills before typing the first prompt.
   */
  async start(command: TurnStartCommand): Promise<TurnState> {
    await ensureFreshConnectedTokens();
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    await this.ensureMcpServersConnected(command.mcpServers);
    const mode = command.mode ?? this.config.mode ?? "auto";
    const startOptions = command.options;
    const state = command.state
      ? {
          ...command.state,
          options: this.resolveTurnOptions(startOptions, command.state.options),
        }
      : createInitialTurnState(mode, this.resolveTurnOptions(startOptions));
    await this.initializeModelRouter(state.options?.model);
    this.stateMachine = state.stateMachine;
    const recovery = this.taskManager.recover(
      state.tasks ?? [],
      state.nextTaskId,
      state.taskOutputTails,
    );
    const pendingLostTaskIds = new Set([
      ...(state.pendingLostTaskReminderTaskIds ?? []),
      ...recovery.lost.map((descriptor) => descriptor.id),
    ]);
    const lostSnapshots = [...pendingLostTaskIds]
      .map((id) => this.taskManager.output(id))
      .filter((snapshot): snapshot is TaskSnapshot => snapshot !== undefined);
    if (lostSnapshots.length > 0) {
      this.recoveredTaskReminder = lostTaskRecoveryReminder(lostSnapshots);
      while (this.taskManager.nextSettled()) {
        // Recovery is delivered through the one-shot reminder, not the live settlement lane.
      }
    }
    this.hydratedQueuedCommands = state.queuedCommands ? [...state.queuedCommands] : undefined;
    const interruptedOnRecovery =
      command.state &&
      (state.status === "running" ||
        (state.status === "sleeping" && this.taskManager.pendingWork().kind !== "sleep"));
    const recoveredState: TurnState = {
      ...state,
      ...(interruptedOnRecovery
        ? { status: "interrupted", agent: { ...state.agent, status: "cancelled" } }
        : {}),
      tasks: [...this.taskManager.list()],
      taskOutputTails: this.snapshotTaskOutputTails(),
      pendingLostTaskReminderTaskIds:
        lostSnapshots.length > 0
          ? lostSnapshots.map((snapshot) => snapshot.descriptor.id)
          : undefined,
      nextTaskId: this.taskManager.nextTaskId(),
    };
    // Hydrate the wire-shaping object in place. `this.wireGuardHorizon` is
    // referenced by the observational context transform; replacing the
    // reference would orphan the transform's view. `Object.assign` over
    // the fresh default lets the persisted state contribute every field
    // it carries without this code knowing the field list.
    if (state.wireGuardHorizon) {
      Object.assign(this.wireGuardHorizon, state.wireGuardHorizon);
    }
    this.setState(recoveredState);
    this.initializeParentAgent();
    this.started = true;
    const hydratedState = this.requireRunnerState();
    this.emit({ type: "turn_started", state: hydratedState });
    return hydratedState;
  }

  /**
   * Route a turn-driving command and resolve with the shared chain terminal.
   * `onAccepted` fires only after the command has entered the active driver or
   * the runner-owned queue; transports can acknowledge delivery at that
   * boundary without leaking transport metadata into durable turn state.
   */
  async turn(command: TurnCommand, onAccepted?: () => void): Promise<TurnTerminalEvent> {
    this.requireStarted();
    await ensureFreshConnectedTokens();
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    // Serialize behind an in-flight compact. Compact advances the wire
    // horizon and may write observations to the durable store; a turn
    // started concurrently would dispatch the pre-compact wire-tail and
    // race the horizon mutation. Awaiting here gives fire-and-forget
    // callers (TUI `/compact` then a prompt) the same ordering RPC mode
    // gets for free by awaiting `compact` between iterations.
    if (this.compactInFlight) {
      await this.compactInFlight;
    }
    if (this.activeTurnPromise) {
      // turn() is the concurrency boundary: repeated calls extend or queue
      // behind the active chain instead of creating a separate parent transcript.
      this.handleCommandDuringActiveTurn(command);
      onAccepted?.();
      return this.activeTurnPromise;
    }

    const activeTurnPromise = this.runTurnLoop(command);
    this.activeTurnPromise = activeTurnPromise;
    onAccepted?.();
    try {
      return await activeTurnPromise;
    } finally {
      if (this.activeTurnPromise === activeTurnPromise) {
        this.activeTurnPromise = undefined;
      }
    }
  }

  private async runTurnLoop(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.turnUsage = undefined;
    this.turnUsageByModel = undefined;
    this.interruptReason = undefined;
    this.interruptCleanup = undefined;
    this.terminalEmitted = false;
    this.activeRootScopeId = `turn-${this.nextRootScope++}` as const;
    const routeStatus = this.modelRouter?.status();
    this.advisorTurnLifecycle =
      this.requireRunnerState().mode === "agent" && this.advisorPolicy?.enabled && routeStatus
        ? new AdvisorTurnLifecycle(routeStatus.assistantSteps)
        : undefined;
    this.turnTools = this.createTools(this.requireRunnerState().mode).tools;
    this.enqueueParentInput(
      command.type === "wake" ? { type: "wake" } : { type: "user_command", command },
    );
    const carriedUserCommands = this.hydratedQueuedCommands?.filter(
      (queued): queued is TurnPromptCommand | TurnAnswerCommand => queued.type !== "wake",
    );
    if (carriedUserCommands && carriedUserCommands.length > 0) {
      for (const queued of carriedUserCommands) {
        this.enqueueParentInput({ type: "user_command", command: queued });
      }
    } else {
      for (const entry of this.getFollowUpQueue()) {
        this.enqueueParentInput({
          type: "user_command",
          command: {
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          },
        });
      }
    }
    this.hydratedQueuedCommands = undefined;

    let questions: TurnQuestion[] | undefined;
    let completion: { status: "completed" | "failed"; result?: string; error?: string } = {
      status: "completed",
    };
    let terminal!: TurnTerminalEvent;
    try {
      while (!questions && !this.interruptReason) {
        this.enqueueAvailableSettlements();
        const pendingBeforeInput = this.taskManager.pendingWork();
        const runnableIndex =
          pendingBeforeInput.kind === "open"
            ? this.parentInputs.findIndex(
                (queued) =>
                  queued.type === "task_settlements" ||
                  (queued.type === "user_command" && queued.command.behavior === "steer"),
              )
            : 0;
        const input =
          runnableIndex >= 0 ? this.parentInputs.splice(runnableIndex, 1)[0] : undefined;
        if (!input) {
          if (pendingBeforeInput.kind !== "open") break;
          if (this.parentInputs.length > 0) {
            await this.taskManager.waitForSettlement();
          } else {
            await this.waitForLoopActivity();
          }
          continue;
        }

        if (
          input.type === "wake" &&
          input.queued === true &&
          this.taskManager.pendingWork().kind !== "sleep" &&
          this.requireRunnerState().status !== "sleeping"
        ) {
          continue;
        }

        const result = await this.processParentLoopInput(input);
        if (result?.type === "ask") {
          if (this.taskManager.pendingWork().kind === "open") {
            // Terminal ⇒ quiescent forbids delivering the ask now. Keep the
            // questions just long enough to remind the parent on its next pass
            // (settlements guarantee one); the parent re-asks if still relevant.
            this.withheldAskQuestions = result.questions;
          } else {
            questions = result.questions;
          }
        }
        if (result?.type === "interrupted") this.interruptReason ??= "Interrupted";
        if (result?.type === "state_completed") {
          this.enqueueParentInput({
            type: "transition_enforcement",
            stateName: result.stateName,
            output: result.output,
          });
        }
        if (result?.type === "terminal") {
          if (this.queueAdvisorCompletionReviewIfDue(result.status)) continue;
          completion = {
            status: result.status === "error" ? "failed" : "completed",
            ...(result.result !== undefined ? { result: result.result } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          };
          if (this.stateMachine?.terminal && !this.stateMachine.terminalAcknowledged) {
            this.enqueueParentInput({ type: "terminal_acknowledgment" });
          }
        }

        // Preserve the old drain rule: follow-ups arriving after a sleep was
        // selected remain queued for the next user-driven turn. A stale wake,
        // however, is skipped above so it cannot clobber the meaningful result.
        if (
          this.taskManager.pendingWork().kind === "sleep" &&
          this.parentInputs.length > 0 &&
          this.parentInputs.every(
            (queued) => queued.type === "user_command" && queued.command.behavior === "follow_up",
          )
        ) {
          break;
        }
      }
    } catch (error) {
      completion = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.taskManager.interruptAll(`Turn failed: ${completion.error}`);
    } finally {
      await this.interruptCleanup;
      if (!this.interruptReason && !questions && this.taskManager.pendingWork().kind === "open") {
        await this.taskManager.interruptAll("Turn exited with in-process work still active.");
        completion = {
          status: "failed",
          error: "Turn exited with in-process work still active.",
        };
      }
      this.discardStaleTaskSettlements();
      const quiescentState = this.snapshotState(this.requireRunnerState());
      try {
        await this.updateMemoryAfterAgentRun(quiescentState.agent.messages, quiescentState.options);
      } catch (error) {
        if (!this.interruptReason) {
          completion = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const state = this.snapshotState(this.requireRunnerState());
      if (this.interruptReason) {
        terminal = {
          type: "interrupted",
          state: {
            ...state,
            status: "interrupted",
            agent: { ...state.agent, status: "cancelled" },
          },
        };
      } else if (questions) {
        terminal = {
          type: "ask",
          questions,
          state: { ...state, status: "waiting_for_human" },
        };
      } else {
        const settledPending = this.taskManager.pendingWork();
        terminal =
          settledPending.kind === "sleep"
            ? {
                type: "sleep",
                wakeAt: settledPending.wakeAt,
                state: { ...state, status: "sleeping" },
              }
            : completeTurn(state, completion.status, completion.result, completion.error);
      }
      terminal = this.attachTurnUsage({ ...terminal, state: this.snapshotState(terminal.state) });
      this.setState(terminal.state);
      this.emitTerminalOnce(terminal);
      this.turnTools = undefined;
      this.advisorTurnLifecycle = undefined;
      this.activeRootScopeId = undefined;
      this.turnUsage = undefined;
      this.turnUsageByModel = undefined;
    }
    return terminal;
  }

  private handleCommandDuringActiveTurn(command: TurnCommand): void {
    if ((command.type === "prompt" || command.type === "answer") && this.parentAgentRunning) {
      // The parent pi-agent is currently driving the public terminal event, so
      // user input can go straight to pi using pi's native steer/follow-up queues.
      this.sendCommandToAgent(this.requireParentAgent(), command);
      return;
    }

    this.enqueueParentInput(
      command.type === "wake" ? { type: "wake", queued: true } : { type: "user_command", command },
    );
    if (
      (command.type === "prompt" || command.type === "answer") &&
      command.behavior === "follow_up"
    ) {
      this.appendFollowUpPrompt(this.commandToUserMessage(command), command.images);
    }
  }

  private sendCommandToAgent(agent: Agent, command: TurnPromptCommand | TurnAnswerCommand): void {
    const message = this.commandToUserMessage(command);
    const images = command.type === "prompt" ? command.images : undefined;
    const agentMessage = buildUserAgentMessage(message, images);
    if (command.behavior === "steer") {
      agent.steer(agentMessage);
    } else {
      this.appendFollowUpPrompt(message, images);
      agent.followUp(agentMessage);
    }
  }

  private enqueueParentInput(input: ParentLoopInput): void {
    this.parentInputs.push(input);
    for (const wake of this.parentInputWaiters) wake();
    this.parentInputWaiters.clear();
  }

  private async waitForLoopActivity(): Promise<void> {
    if (this.parentInputs.length > 0) return;
    let wake!: () => void;
    const parentInput = new Promise<void>((resolve) => {
      wake = resolve;
      this.parentInputWaiters.add(wake);
    });
    try {
      await Promise.race([this.taskManager.waitForSettlement().then(() => undefined), parentInput]);
    } finally {
      this.parentInputWaiters.delete(wake);
    }
  }

  private enqueueAvailableSettlements(): void {
    if ([...this.taskSettlementDelivery.values()].includes("foreground_pending")) return;
    const settlements: TaskSettlement[] = [];
    for (
      let settlement = this.taskManager.nextSettled();
      settlement;
      settlement = this.taskManager.nextSettled()
    ) {
      const delivery = this.taskSettlementDelivery.get(settlement.id);
      this.taskSettlementDelivery.delete(settlement.id);
      if (delivery !== "suppress") settlements.push(settlement);
    }
    if (settlements.length === 0) return;

    const canSteer =
      this.parentAgentRunning &&
      this.parentControlResults.length === 0 &&
      settlements.every((settlement) => !this.stateTasks.has(settlement.id));
    if (canSteer) {
      const snapshots = settlements
        .map((settlement) => this.taskManager.output(settlement.id))
        .filter((snapshot) => snapshot !== undefined);
      if (snapshots.length > 0) {
        this.requireParentAgent().steer(
          buildUserAgentMessage(settlementNotice(snapshots), undefined),
        );
        return;
      }
    }
    this.parentInputs.unshift({ type: "task_settlements", settlements });
  }

  private handleTaskEvent(event: TaskEvent): void {
    if (event.type === "started") {
      this.emit({ type: "task_started", task: event.descriptor });
      return;
    }
    if (event.type === "output") {
      this.emit({ type: "task_output", taskId: event.id, chunk: event.chunk });
      return;
    }
    this.emit({ type: "task_settled", settlement: event.settlement });
    if (this.taskSettlementDelivery.get(event.settlement.id) === "foreground_pending") return;
    this.scheduleSettlementDelivery();
  }

  private scheduleSettlementDelivery(): void {
    if (this.settlementDeliveryQueued) return;
    this.settlementDeliveryQueued = true;
    queueMicrotask(() => {
      this.settlementDeliveryQueued = false;
      this.enqueueAvailableSettlements();
      for (const wake of this.parentInputWaiters) wake();
      this.parentInputWaiters.clear();
    });
  }

  private discardStaleTaskSettlements(): void {
    for (
      let settlement = this.taskManager.nextSettled();
      settlement;
      settlement = this.taskManager.nextSettled()
    ) {
      this.stateTasks.delete(settlement.id);
      this.ignoredTaskSettlements.delete(settlement.id);
      this.taskSettlementDelivery.delete(settlement.id);
    }
    for (const input of this.parentInputs) {
      if (input.type !== "task_settlements") continue;
      for (const settlement of input.settlements) {
        this.stateTasks.delete(settlement.id);
        this.ignoredTaskSettlements.delete(settlement.id);
        this.taskSettlementDelivery.delete(settlement.id);
      }
    }
    const userInputs = this.parentInputs.filter((input) => input.type !== "task_settlements");
    this.parentInputs.splice(0, this.parentInputs.length, ...userInputs);
  }

  private commandToUserMessage(command: TurnPromptCommand | TurnAnswerCommand): string {
    if (command.type === "prompt") {
      return this.skillContext.resolveSlashSkillPrompt(command.message);
    }

    const answerXml = toXML([{ questions: command.questions }, { answers: command.answers }]);
    const base = dedent`
      Here are my answers to your questions.

      ${answerXml}
    `;
    if (!command.message?.trim()) return base;
    return `${base}\n\n${this.skillContext.resolveSlashSkillPrompt(command.message)}`;
  }

  private replaceFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    this.setFollowUpQueue(entries);
    this.parentAgent?.clearFollowUpQueue();
    this.parentInputs.splice(
      0,
      this.parentInputs.length,
      ...this.parentInputs.filter(
        (input) => input.type !== "user_command" || input.command.behavior !== "follow_up",
      ),
    );
    if (this.parentAgentRunning) {
      for (const entry of entries) {
        this.parentAgent?.followUp(buildUserAgentMessage(entry.message, entry.images));
      }
    } else if (this.activeTurnPromise) {
      for (const entry of entries) {
        this.enqueueParentInput({
          type: "user_command",
          command: {
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          },
        });
      }
    }
    this.emitFollowUpQueue();
  }

  private isFollowUpQueueCommand(
    command: TurnCommand,
  ): command is TurnPromptCommand | TurnAnswerCommand {
    return (
      (command.type === "prompt" || command.type === "answer") && command.behavior === "follow_up"
    );
  }

  private appendFollowUpPrompt(message: string, images?: TurnPromptImage[]): void {
    const entry: TurnFollowUpQueueEntry =
      images && images.length > 0 ? { message, images } : { message };
    this.setFollowUpQueue([...this.getFollowUpQueue(), entry]);
    this.emitFollowUpQueue();
  }

  private removeQueuedFollowUpPrompt(command: TurnCommand): void {
    if (!this.isFollowUpQueueCommand(command)) return;
    this.removeFollowUpPrompt(this.commandToUserMessage(command));
  }

  /**
   * Drop the first queued entry whose `message` text matches. Pi-agent's
   * persisted transcript only retains the text portion of multimodal user
   * content, so the text is the canonical dedup key for both live and
   * replayed follow-ups.
   */
  private removeFollowUpPrompt(message: string): void {
    const entries = this.getFollowUpQueue();
    const index = entries.findIndex((entry) => entry.message === message);
    if (index === -1) return;
    this.setFollowUpQueue([...entries.slice(0, index), ...entries.slice(index + 1)]);
    this.emitFollowUpQueue();
  }

  private clearFollowUpQueue(): void {
    if (this.getFollowUpQueue().length === 0) return;
    this.setFollowUpQueue([]);
    this.emitFollowUpQueue();
  }

  private emitFollowUpQueue(): void {
    this.emit({ type: "follow_up_queue", followUpQueue: this.getFollowUpQueue() });
  }

  interrupt(_command: TurnInterruptCommand): void {
    this.requireStarted();
    if (!this.state) return;
    this.interruptReason = "Interrupted";
    this.parentAgentInterrupted = this.parentAgentRunning;
    this.parentAgent?.abort();
    this.parentAgent?.clearAllQueues();
    this.parentInputs.length = 0;
    this.clearFollowUpQueue();
    this.parentAgentRunning = false;
    this.interruptCleanup = this.interruptTasks("Interrupted");
    if (!this.activeTurnPromise) {
      this.terminalEmitted = false;
      void this.interruptCleanup.then(() => {
        const state = this.snapshotState(this.requireRunnerState());
        const terminal: TurnTerminalEvent = {
          type: "interrupted",
          state: {
            ...state,
            status: "interrupted",
            agent: { ...state.agent, status: "cancelled" },
          },
        };
        this.setState(terminal.state);
        this.emitTerminalOnce(terminal);
      });
    }
  }

  protected emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private async processParentLoopInput(
    input: PendingParentLoopInput,
  ): Promise<SettledDecision["outcome"] | undefined> {
    switch (input.type) {
      case "user_command":
        return this.runUserCommandPass(input.command, input.continuation);
      case "task_settlements":
        return this.processTaskSettlements(input.settlements);
      case "transition_enforcement":
        return this.selectNextStateAfterCompletion(input.stateName, input.output);
      case "terminal_acknowledgment":
        return this.runTerminalAcknowledgmentPass();
      case "advisor_completion_review":
        return this.runAdvisorCompletionReviewPass();
      case "wake":
        return this.runWakeInput();
    }
  }

  private async runUserCommandPass(
    command: TurnPromptCommand | TurnAnswerCommand,
    continuation = false,
  ) {
    const runningState = {
      ...this.requireRunnerState(),
      status: "running" as const,
    };
    const state = continuation ? runningState : this.clearFinishedTodosAtTurnStart(runningState);
    let prompt = this.commandToUserMessage(command);
    if (
      !continuation &&
      command.behavior === "steer" &&
      this.taskManager.pendingWork().kind === "open"
    ) {
      prompt = `${systemReminder(dedent`
        <system-reminder>
        The user sent this as a steer message while state-machine work is running.
        If the state-machine should change course, call select_state_machine_state to restart the current state with updated input or choose a different state.
        </system-reminder>
      `)}\n\n${prompt}`;
    }
    const todoReminder = continuation ? undefined : formatCarriedTodosReminder(state.todos);
    if (todoReminder) prompt = `${todoReminder}\n\n${prompt}`;
    if (!continuation) this.removeQueuedFollowUpPrompt(command);
    const worker = await this.runParentPass({
      state,
      prompt,
      images: promptImagesToContent(command.images),
      continuation,
    });
    this.setState(worker.outcome.state);
    if (
      worker.outcome.type === "complete" &&
      worker.outcome.status === "failed" &&
      this.taskManager.pendingWork().kind === "sleep"
    ) {
      this.emit({
        type: "system",
        level: "error",
        message: worker.outcome.error ?? worker.outcome.result ?? "Prompt failed while waiting.",
      });
    }
    if (worker.outcome.type === "interrupted") return { type: "interrupted" } as const;
    if (state.mode === "agent") {
      if (worker.control.type === "ask_user_question") {
        return { type: "ask", questions: worker.control.questions } as const;
      }
      return worker.outcome.status === "failed"
        ? ({ type: "terminal", status: "error", error: worker.outcome.error } as const)
        : ({ type: "terminal", status: "completed", result: worker.outcome.result } as const);
    }
    const result = await this.stateMachineResultFromWorker(worker, worker.outcome.state);
    if (result) return result;
    return worker.outcome.status === "failed"
      ? ({ type: "terminal", status: "error", error: worker.outcome.error } as const)
      : ({ type: "terminal", status: "completed", result: worker.outcome.result } as const);
  }

  private async runParentPass(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const agent = this.requireParentAgent();
    if (agent.hasQueuedMessages()) {
      throw new Error("Parent pi steer/follow-up queues must be empty at internal pass start.");
    }
    const recoveredTaskReminder = this.recoveredTaskReminder;
    this.recoveredTaskReminder = undefined;
    if (recoveredTaskReminder) {
      this.setState({
        ...this.requireRunnerState(),
        pendingLostTaskReminderTaskIds: undefined,
      });
    }
    const recoveryInput = recoveredTaskReminder
      ? {
          ...input,
          state: { ...input.state, pendingLostTaskReminderTaskIds: undefined },
          prompt: `${recoveredTaskReminder}\n\n${input.prompt}`,
        }
      : input;
    const parked = currentParkState(this.stateMachine);
    // Append to the pass already being made, so a transition out of park costs
    // no extra model call. The selection tools put the same reminder in their
    // terminating result on the entry pass, before currentState has changed.
    return this.runAgentWorker(
      parked
        ? { ...recoveryInput, prompt: `${recoveryInput.prompt}\n\n${parkNudge(parked.name)}` }
        : recoveryInput,
    );
  }

  private async runWakeInput(): Promise<SettledDecision["outcome"] | undefined> {
    const planned = planWake(this.stateMachine, this.clock.now());
    if (!planned) {
      return { type: "terminal", status: "completed", result: "Nothing to wake." };
    }
    await this.cancelScheduledTasks("Scheduled wake fired.");
    this.setStateMachine(planned.session);
    return this.executePlannedWork(planned.work);
  }

  private async runTerminalAcknowledgmentPass() {
    const session = this.stateMachine;
    if (!session?.terminal || session.terminalAcknowledged) return undefined;
    this.setStateMachine(markTerminalAcknowledged(session));
    const acknowledged = this.stateMachine;
    if (!acknowledged?.terminal) return undefined;
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: formatStateMachineTerminalAcknowledgmentPrompt({ session: acknowledged }),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    if (worker.outcome.type === "interrupted") return { type: "interrupted" } as const;
    return this.stateMachineResultFromWorker(worker, worker.outcome.state);
  }

  private async runAdvisorCompletionReviewPass() {
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: systemReminder(ADVISOR_COMPLETION_REVIEW_REMINDER),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    if (worker.outcome.type === "interrupted") return { type: "interrupted" } as const;
    if (worker.control.type === "ask_user_question") {
      return { type: "ask", questions: worker.control.questions } as const;
    }
    return worker.outcome.status === "failed"
      ? ({ type: "terminal", status: "error", error: worker.outcome.error } as const)
      : ({ type: "terminal", status: "completed", result: worker.outcome.result } as const);
  }

  /**
   * Queue a fresh parent continuation only when a completed agent-mode turn did enough work to
   * benefit from review. A successful consultation with no subsequent real-world tool work already
   * saw the final available evidence and satisfies this checkpoint without call counting. Otherwise
   * completion starts a distinct consultation phase, so its first call gets a fresh ordinary floor
   * even when the orientation call was recent. The checkpoint is marked before enqueueing so
   * failures and ignored reminders remain non-recursive.
   */
  private queueAdvisorCompletionReviewIfDue(
    status: "completed" | "failed" | "cancelled" | "error",
  ): boolean {
    const lifecycle = this.advisorTurnLifecycle;
    const routeStatus = this.modelRouter?.status();
    if (
      status !== "completed" ||
      !lifecycle ||
      !routeStatus ||
      this.taskManager.pendingWork().kind === "open" ||
      !lifecycle.takeCompletionCheckpoint(routeStatus.assistantSteps)
    ) {
      return false;
    }
    // Completion review is a distinct product lifecycle phase, just like a
    // replacement model starts a fresh phase after a route switch. Reset the
    // step floor instead of bypassing the advisor gate so the ordinary
    // in-flight reservation and post-success cooldown still apply.
    this.modelRouter?.resetAdvisorCooldown();
    this.parentInputs.unshift({ type: "advisor_completion_review" });
    return true;
  }

  private async executePlannedWork(
    work: PlannedWork,
  ): Promise<SettledDecision["outcome"] | undefined> {
    if ("terminal" in work) {
      const settled = recordPlannedTerminal(this.requireStateMachine(), work.terminal);
      this.setStateMachine(settled.session);
      return settled.outcome;
    }
    if ("schedule" in work) {
      if (work.schedule.wakeAt > this.clock.now()) {
        this.taskManager.start({
          kind: "scheduled",
          name: work.schedule.stateName,
          label: `Wait for ${work.schedule.stateName}`,
          ownerScopeId: this.requireRootScope(),
          wakeAt: work.schedule.wakeAt,
        });
        const settled = recordScheduled(
          this.requireStateMachine(),
          work.schedule.stateName,
          work.schedule.wakeAt,
        );
        this.setStateMachine(settled.session);
        return settled.outcome;
      }
      const now = this.clock.now();
      const startedAt = this.stateMachine?.progress?.states[work.schedule.stateName]?.startedAt;
      const settled = recordSettled(
        this.requireStateMachine(),
        work.schedule.stateName,
        "timer",
        {
          type: "completed",
          output: {
            elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
            timestamp: now,
          },
        },
        undefined,
        now,
      );
      this.setStateMachine(settled.session);
      return settled.outcome;
    }
    if ("park" in work) return undefined;
    if ("subagent" in work.run) {
      this.startSubagentTask(work.run.subagent, work.run.stateName);
    } else {
      this.startShellTask(work.run.shell, work.run.stateName, work.run.pollPolicy);
    }
    return undefined;
  }

  private startSubagentTask(spec: SubagentSpec, stateName: string): void {
    const ownerScopeId = this.requireRootScope();
    const handle = this.taskManager.start({
      kind: "subagent",
      name: stateName,
      label: `Run state ${stateName}`,
      ownerScopeId,
      execute: async ({ signal, taskId }) => {
        const run = this.createStateSubagentRun({
          state: { kind: "agent", name: stateName, ...spec },
          prompt: spec.prompt,
          origin: { taskId },
        });
        const metadata = this.stateTasks.get(taskId);
        if (metadata?.kind === "agent") metadata.run = run;
        const interrupt = () => run.interrupt(String(signal.reason ?? "Interrupted"));
        if (signal.aborted) interrupt();
        signal.addEventListener("abort", interrupt, { once: true });
        try {
          return await run.prompt();
        } finally {
          signal.removeEventListener("abort", interrupt);
        }
      },
    });
    this.stateTasks.set(handle.id, { kind: "agent", stateName });
  }

  private startShellTask(spec: ShellSpec, stateName: string, pollPolicy?: PollPolicy): void {
    const shell = createShellStateHandle({
      command: spec.command,
      cwd: resolveStateCwd(spec.cwd, this.config.cwd ?? process.cwd()),
      timeoutMs: spec.timeoutMs,
      successCodes: spec.successCodes,
    });
    let taskId!: TaskId;
    let finish!: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Stop semantics are uniform across executors: process groups die by SIGKILL
    // immediately (matching pi-bash), so the interrupted terminal is never gated
    // on a grace window. Graceful TERM cleanup, if ever needed, is a future
    // explicit opt-in, not a blanket default.
    const unregisterReaper = this.taskManager.registerReaper(async (reason) => {
      shell.interrupt(reason);
      await finishedPromise;
    });
    const handle = this.taskManager.start({
      kind: "tool",
      name: stateName,
      label: `Run state ${stateName}`,
      ownerScopeId: this.requireRootScope(),
      execute: async ({ signal, onOutput }) => {
        const interrupt = () => shell.interrupt(String(signal.reason ?? "Interrupted"));
        signal.addEventListener("abort", interrupt, { once: true });
        try {
          const output = await shell.run();
          onOutput(output.stdout);
          return { type: "completed", output } satisfies ShellSettlement;
        } catch (error) {
          const reason = shell.interruptedReason();
          if (reason !== undefined)
            return { type: "interrupted", reason } satisfies ShellSettlement;
          return {
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          } satisfies ShellSettlement;
        } finally {
          signal.removeEventListener("abort", interrupt);
          finish();
          unregisterReaper();
        }
      },
    });
    taskId = handle.id;
    this.stateTasks.set(taskId, {
      kind: pollPolicy ? "poll" : "script",
      stateName,
      shell,
      ...(pollPolicy ? { pollPolicy } : {}),
    });
  }

  private async recordTaskSettlements(
    settlements: readonly TaskSettlement[],
  ): Promise<SettledDecision["outcome"] | undefined> {
    let latest: SettledDecision["outcome"] | undefined;
    for (const settlement of settlements) {
      if (this.ignoredTaskSettlements.delete(settlement.id)) {
        this.stateTasks.delete(settlement.id);
        continue;
      }
      const metadata = this.stateTasks.get(settlement.id);
      if (!metadata) continue;
      this.stateTasks.delete(settlement.id);
      const result = this.stateResultFromSettlement(settlement);
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        result,
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      latest = recorded.outcome;
      if (latest.type === "sleep") {
        this.taskManager.start({
          kind: "scheduled",
          name: metadata.stateName,
          label: `Wait for ${metadata.stateName}`,
          ownerScopeId: this.requireRootScope(),
          wakeAt: latest.wakeAt,
        });
      }
    }
    return latest;
  }

  private async processTaskSettlements(
    settlements: readonly TaskSettlement[],
  ): Promise<SettledDecision["outcome"] | undefined> {
    const stateSettlements = settlements.filter(
      (settlement) =>
        this.stateTasks.has(settlement.id) || this.ignoredTaskSettlements.has(settlement.id),
    );
    const taskSettlements = settlements.filter(
      (settlement) => !stateSettlements.includes(settlement),
    );
    const stateOutcome = await this.recordTaskSettlements(stateSettlements);
    if (taskSettlements.length === 0) return stateOutcome;
    if (stateOutcome) {
      this.parentInputs.unshift({ type: "task_settlements", settlements: taskSettlements });
      return stateOutcome;
    }

    const snapshots = taskSettlements
      .map((settlement) => this.taskManager.output(settlement.id))
      .filter((snapshot) => snapshot !== undefined);
    if (snapshots.length === 0) return stateOutcome;
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: settlementNotice(snapshots),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    if (worker.outcome.type === "interrupted") return { type: "interrupted" };
    if (worker.control.type === "ask_user_question") {
      return { type: "ask", questions: worker.control.questions };
    }
    if (this.requireRunnerState().mode !== "agent") {
      const controlled = await this.stateMachineResultFromWorker(worker, worker.outcome.state);
      if (controlled) return controlled;
    }
    return worker.outcome.status === "failed"
      ? { type: "terminal", status: "error", error: worker.outcome.error }
      : { type: "terminal", status: "completed", result: worker.outcome.result };
  }

  private stateResultFromSettlement(settlement: TaskSettlement): SubagentResult | ShellSettlement {
    if (settlement.status === "completed") {
      return settlement.result as SubagentResult | ShellSettlement;
    }
    if (settlement.status === "stopped") {
      return { type: "interrupted", reason: settlement.reason };
    }
    return {
      type: "failed",
      error:
        settlement.status === "failed"
          ? settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)
          : `Task ${settlement.id} was lost.`,
    };
  }

  private partialStateOutput(metadata: StateTaskMetadata) {
    if (metadata.kind === "agent") {
      const assistantText = metadata.run?.partialAssistantText();
      return assistantText ? { assistantText } : undefined;
    }
    return metadata.shell.partialOutput();
  }

  private async interruptTasks(reason: string): Promise<void> {
    const scheduledState = currentScheduledState(this.stateMachine);
    const scheduledTask = scheduledState
      ? this.taskManager
          .list()
          .find(
            (task) =>
              task.kind === "scheduled" &&
              task.status === "scheduled" &&
              task.name === scheduledState.name,
          )
      : undefined;
    if (scheduledState && scheduledTask) {
      const recorded = recordSettled(
        this.requireStateMachine(),
        scheduledState.name,
        scheduledState.kind,
        { type: "interrupted", reason },
        undefined,
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      this.ignoredTaskSettlements.add(scheduledTask.id);
    }
    for (const [id, metadata] of this.stateTasks) {
      if (this.taskManager.output(id)?.descriptor.status !== "running") continue;
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        { type: "interrupted", reason },
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      this.ignoredTaskSettlements.add(id);
    }
    await this.taskManager.interruptAll(reason);
  }

  private async cancelScheduledTasks(reason: string): Promise<void> {
    const scheduled = this.taskManager.list().filter((task) => task.status === "scheduled");
    for (const task of scheduled) this.ignoredTaskSettlements.add(task.id);
    await Promise.all(scheduled.map((task) => this.taskManager.stop(task.id, reason)));
  }

  /**
   * Build a loop-warning system reminder when the orchestrator has selected the
   * same state many times in a row within a short window with no other state
   * running in between. This is the idle-"holding" hot loop: re-selecting a
   * state to "keep waiting" is a no-op because selecting runs the state again
   * immediately rather than suspending. The reminder re-teaches the only
   * primitives that actually wait — park for a parent-owned human gate, a poll
   * for a checkable condition, a timer for a fixed time — and tells the parent
   * to stop re-selecting the same state unchanged. Returns undefined when the
   * streak is below threshold or spread over too long a span to be a hot loop.
   */
  private repeatedSelectionLoopWarning(stateName: string): string | undefined {
    const session = this.stateMachine;
    const count = session ? repeatedSelectionLoopCount(session, stateName) : undefined;
    if (count === undefined) return undefined;
    return dedent`
      <system-reminder>
      LOOP DETECTED: you have selected the "${stateName}" state ${count} times in a row, with no other state running in between, in quick succession. Selecting a state is NOT how you wait — every select_state_machine_state call runs the state again immediately and returns, so re-selecting the same "holding" state over and over is a no-op hot loop that suspends nothing.

      If you are waiting on something, back it with the primitive that actually suspends, chosen by WHAT you are waiting for:
      - a human reply or approval → select a park state, ask the user yourself with ask_user_question, then END YOUR TURN. The user's answer arrives as a fresh parent turn; select the next state when the park's purpose is fulfilled.
      - a condition a command can check (CI finished, a file appeared, a deploy went ready) → a poll state whose command exits success only when the condition is actually met.
      - a fixed future time → a timer state (wakeAt or wakeAfterMs).

      If you are not waiting but re-running "${stateName}" to fix a failure, change override.prompt to address the specific failure before selecting again — selecting it unchanged reproduces the same result. If there is nothing left to do here, advance to the next real state or a terminal. Do NOT select "${stateName}" again unchanged.
      </system-reminder>
    `;
  }

  private async selectNextStateAfterCompletion(
    stateName: string,
    output?: unknown,
  ): Promise<SettledDecision["outcome"] | undefined> {
    const loopWarning = this.repeatedSelectionLoopWarning(stateName);
    return this.enforceParentTransition(
      (retryInstruction) =>
        systemReminder(dedent`
        The state "${stateName}" finished.

        ${toXML({
          state_completed: {
            output: output ?? null,
          },
        })}

        ${loopWarning ?? ""}

        <system-reminder>
        THIS TURN MUST END WITH A select_state_machine_state TOOL CALL. The state machine only advances when the tool call is actually emitted — nothing else, including text, thinking, or narration, advances it. Even if your conclusion is obvious ("this is internal plumbing, transition to X"), the conclusion is not the action; you must emit the select_state_machine_state tool call for state X in this same turn. Responses that narrate the transition without the tool call ("I should transition to X", "no user-facing post needed, moving on to Y", "the next state is Z") will be rejected and you will be re-prompted. This rule holds whether the state output is a user-facing artifact or purely internal plumbing — internal plumbing still requires the tool call to advance the machine, it just skips the user-facing message.

        ${retryInstruction ?? ""}

        If the state produced output the user would want to see — a written artifact (poem, summary, draft), a finding, a status the user is watching, or anything else the background work was meant to surface — post that content to the user in this turn before or alongside the tool call. The user does not see state output, transcripts, or tool results from background states; if you do not relay it here, they never see it. Skip the user-facing message only when the state output is purely internal plumbing (an ack, a control signal, a value that only matters to the next state).

        You are the orchestrator and are responsible for this sub-agent's output. Treat the state_completed block above as a claim, not as verified truth. The sub-agent may have hallucinated success, skipped steps, swallowed errors, or misreported what it did. Before transitioning, review the output against reality: read the files it claims to have changed, run the build/test/lint it claims to have passed, and confirm any IDs, paths, counts, or statuses it asserts. If the output is wrong, incomplete, or unverifiable, do not just blindly re-select the same state — the sub-agent will hallucinate the same result a second time. Re-select the state with an override.state.prompt that addresses the specific failure (require a verification step, name the exact file path or tool to use, forbid the hallucinated phrasing), or select a different state. Tuning the sub-agent's prompt is the orchestrator's lever — use it. Do not silently take over the sub-agent's job by running its tools yourself; that hides the broken state from future runs. Do not propagate an unverified claim into the next state's prompt as fact, and do not relay it to the user as finished work. The orchestrator owns correctness; the sub-agent only owns effort.

        CARRY FORWARD BEFORE YOU SELECT. The next state runs in a fresh sub-agent that cannot see this state_completed output, your reasoning, or your reply text — the ONLY thing it receives is the \`input\` and \`override.prompt\` you pass in the select call. So if the next state's job depends on anything this state just produced (a root cause, file path, diagnosis, ID, count, decision), inline those exact facts into the select's \`input\`/\`override.prompt\` on the FIRST transition into it. Do not select it bare and let it come back confused, then add the context on a retry — a select that advances to a finding-dependent state carrying none of the finding is already wrong, even with the right state name. Summarizing the finding in your message to the user does not carry it forward.
        </system-reminder>
      `),
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  /**
   * Shared bounded-retry loop for transitions the parent owes the machine.
   * Re-prompts up to `PARENT_TRANSITION_RETRY_BUDGET` times with `buildPrompt`
   * (the second and later attempts carry a retry reminder); the first accepted
   * selection ends enforcement, with an immediate outcome only for synchronous
   * work. When the budget is exhausted with no control action, records an
   * `error` terminal carrying `failureReason` — a runtime failure of the
   * machine, not a deliberate `failed` selection.
   */
  private async enforceParentTransition(
    buildPrompt: (retryInstruction: string | undefined) => string,
    failureReason: string,
  ): Promise<SettledDecision["outcome"] | undefined> {
    for (let attempt = 1; attempt <= PARENT_TRANSITION_RETRY_BUDGET; attempt++) {
      const retryInstruction =
        attempt === 1
          ? undefined
          : `This is retry ${attempt} of ${PARENT_TRANSITION_RETRY_BUDGET}. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;
      const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
      const workerResult = await this.runParentPass({
        state: turnState,
        prompt: buildPrompt(retryInstruction),
        continuation: true,
      });
      this.setState(workerResult.outcome.state);
      const result = await this.stateMachineResultFromWorker(
        workerResult,
        workerResult.outcome.state,
      );
      if (result) return result;
      // Starting an asynchronous state has no immediate outcome. The select
      // control itself proves the transition obligation was satisfied.
      if (workerResult.control.type === "select_state_machine_state") return undefined;
    }

    const failed = failActiveSession(
      this.requireStateMachine(),
      this.stateMachine?.currentState ?? "",
      failureReason,
    );
    this.setStateMachine(failed.session);
    return failed.outcome;
  }

  protected createStateSubagentRun(input: {
    state: StateMachineAgentState;
    prompt: string;
    origin: TurnEventOrigin;
  }): SubagentRun {
    const spec: SubagentSpec = {
      prompt: input.prompt,
      ...(input.state.systemPrompt ? { systemPrompt: input.state.systemPrompt } : {}),
      ...(input.state.allowedSkills ? { allowedSkills: input.state.allowedSkills } : {}),
      ...(input.state.cwd ? { cwd: input.state.cwd } : {}),
      ...(input.state.model ? { model: input.state.model } : {}),
      ...(input.state.thinkingLevel ? { thinkingLevel: input.state.thinkingLevel } : {}),
      ...(input.state.forkContext ? { forkContext: true } : {}),
    };
    const session = this.stateMachine;
    const machineContext = session
      ? { definition: session.definition, currentState: input.state.name }
      : undefined;
    return this.subagentExecutor(spec, {
      origin: input.origin,
      ...(machineContext ? { machineContext } : {}),
    });
  }

  /** Build a public spawn only after TaskManager has allocated its identity and child scope. */
  protected async createSpawnedSubagentRun(
    publicSpec: SubagentSpec,
    taskId: TaskId,
    ownerScopeId: ScopeId,
    childScopeId: `task:${TaskId}`,
    forkSource?: NonNullable<SubagentExecutionContext["forkSource"]>,
    callerModelSetting?: string,
  ): Promise<SubagentRun> {
    const parentSetting =
      callerModelSetting ??
      this.requireRunnerState().options?.model ??
      this.config.model ??
      DEFAULT_CLI_MODEL;
    const selection = await this.selectSpawnModel(publicSpec.prompt, parentSetting);
    const memorySessionId = this.config.sessionId
      ? `${this.config.sessionId}:sub:${taskId}`
      : undefined;
    return this.subagentExecutor(
      {
        ...publicSpec,
        model: selection.modelName,
        ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
      },
      {
        origin: { taskId },
        childScopeId,
        ownerScopeId,
        memoryContext: {
          ...(memorySessionId ? { sessionId: memorySessionId } : {}),
          horizon: createInitialHorizon(),
        },
        ...(forkSource ? { forkSource } : {}),
      },
    );
  }

  /** Stateless spawn classifier seam; deliberately never consults the session ModelRouter. */
  protected async selectSpawnModel(prompt: string, parentSetting: string) {
    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    return classifySpawnModel(prompt, parentSetting, {
      table,
      resolveCatalog: routingCatalogAdapter,
      classifierOptions: this.classifierOptions(table),
    });
  }

  protected async dropSubagentScratch(taskId: TaskId): Promise<void> {
    const session = this.memoryPersistence?.session;
    if (!session || !this.config.sessionId) return;
    await replaceSessionObservations(session, `${this.config.sessionId}:sub:${taskId}`, []);
  }

  private requireRunnerState(): TurnState {
    if (!this.state) {
      throw new Error("Turn runner has not been started.");
    }
    return this.state;
  }

  private requireStateMachine(): StateMachineSession {
    if (!this.stateMachine) throw new Error("No state machine is active.");
    return this.stateMachine;
  }

  /** Protected so test probes can supply a scope when driving tools outside a turn. */
  protected requireRootScope(): ScopeId {
    if (!this.activeRootScopeId) throw new Error("No turn root scope is active.");
    return this.activeRootScopeId;
  }

  private setStateMachine(session: StateMachineSession, notify = false): void {
    this.stateMachine = session;
    if (notify) this.emit({ type: "state_machine", stateMachine: session });
  }

  private getActiveStateOutput() {
    for (const [id, metadata] of this.stateTasks) {
      if (this.taskManager.output(id)?.descriptor.status !== "running") continue;
      if (metadata.kind === "agent") {
        const assistantText = metadata.run?.partialAssistantText();
        return assistantText
          ? { state: metadata.stateName, kind: "agent" as const, output: { assistantText } }
          : { state: metadata.stateName, kind: "agent" as const };
      }
      const output = metadata.shell.partialOutput();
      return output
        ? { state: metadata.stateName, kind: metadata.kind, output }
        : { state: metadata.stateName, kind: metadata.kind };
    }
    return undefined;
  }

  private captureParentControlResult(result: TurnRunnerControlResult): void {
    if (result.type === "none") return;
    if (this.parentControlResults.length > 0) {
      throw new Error("A parent pass produced more than one control result.");
    }
    this.parentControlResults.push(result);
  }

  private consumeParentControlResult(): TurnRunnerControlResult {
    const result = this.parentControlResults.shift() ?? { type: "none" as const };
    if (this.parentControlResults.length > 0) {
      throw new Error("A parent pass produced more than one control result.");
    }
    return result;
  }

  private attachTurnUsage(terminal: TurnTerminalEvent): TurnTerminalEvent {
    if (!this.turnUsage) return terminal;
    return {
      ...terminal,
      turnUsage: this.turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      ...(this.lastParentUsageSnapshot
        ? {
            effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
            contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
            lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
          }
        : {}),
    };
  }

  private emitTerminalOnce(terminal: TurnTerminalEvent): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.emit(terminal);
  }

  getState(): TurnState | undefined {
    if (!this.state) return undefined;
    return this.snapshotState(this.state);
  }

  private snapshotState(state: TurnState): TurnState {
    const parentAgent = this.parentAgent
      ? {
          ...state.agent,
          status: state.agent.status,
          messages: this.parentAgent.state.messages,
        }
      : state.agent;
    const snapshot: TurnState = {
      ...state,
      agent: parentAgent,
      stateMachine: this.stateMachine,
      todos: copyOptionalArray(state.todos ?? this.state?.todos),
      followUpQueue: copyOptionalArray(state.followUpQueue ?? this.state?.followUpQueue),
      queuedCommands:
        this.activeRootScopeId !== undefined
          ? this.parentInputs
              .filter(
                (input): input is Extract<ParentLoopInput, { type: "user_command" }> =>
                  input.type === "user_command",
              )
              .map((input) => input.command)
          : (this.hydratedQueuedCommands ??
            copyOptionalArray(state.queuedCommands ?? this.state?.queuedCommands)),
      tasks: [...this.taskManager.list()],
      taskOutputTails: this.snapshotTaskOutputTails(),
      nextTaskId: this.taskManager.nextTaskId(),
      // Carry wire-shaping state through every snapshot so persistence
      // layers (state.json, terminal payloads, getState consumers) see
      // the current value. Copy by spread so consumers can't mutate the
      // runner's live object. Omit when nothing has moved off the
      // fresh-runner default so untouched sessions stay schema-clean;
      // `evictionHorizon` is the only field today, so it doubles as the
      // dirty sentinel — revisit when more wire-shaping fields land.
      ...(this.wireGuardHorizon.evictionHorizon > 0
        ? { wireGuardHorizon: { ...this.wireGuardHorizon } }
        : {}),
    };
    return this.applyAutoStateCompaction(snapshot);
  }

  private snapshotTaskOutputTails(): TurnState["taskOutputTails"] {
    const tails: NonNullable<TurnState["taskOutputTails"]> = {};
    for (const descriptor of this.taskManager.list()) {
      const output = this.taskManager.output(descriptor.id)?.output;
      if (output && output.length > 0) {
        tails[descriptor.id] = output.slice(-3).map((chunk) => chunk.slice(-1_500));
      }
    }
    return Object.keys(tails).length > 0 ? tails : undefined;
  }

  /**
   * Caps the size of every state that leaves the runner via emit/return/
   * getState. Runs only when `TurnRunnerConfig.autoStateCompaction` is
   * enabled — the single choke point ensures persistence layers, terminal
   * payloads, and external observers all see the same trimmed state.
   */
  private applyAutoStateCompaction(state: TurnState): TurnState {
    const options = this.resolveCompactionOptions();
    if (!options) return state;
    const { state: capped, evicted, bytes } = compactTurnState(state, options);
    if (evicted > 0) {
      console.warn(
        `[duet-agent] turn state exceeded auto-compaction ceiling; evicted ${evicted} oldest message(s) (now ${bytes} bytes) for session ${this.config.sessionId ?? "<unknown>"}`,
      );
    }
    return capped;
  }

  private resolveCompactionOptions(): AutoStateCompactionOptions | undefined {
    // On by default: `undefined` and `true` both enable the 100 MB ceiling so
    // unbounded `state.json` growth can't wedge persistence. Only an explicit
    // `false` disables compaction.
    const setting = this.config.autoStateCompaction;
    if (setting === false) return undefined;
    if (setting === undefined || setting === true) return {};
    return setting;
  }

  private setState(state: TurnState): void {
    this.state = this.snapshotState(state);
  }

  private snapshotActiveAgentState(): void {
    if (!this.state) return;
    this.state = this.snapshotState(this.state);
  }

  private getFollowUpQueue(): TurnFollowUpQueueEntry[] {
    return [...(this.state?.followUpQueue ?? [])];
  }

  private setFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, followUpQueue: [...entries] });
  }

  private getTodos(): TurnTodo[] {
    return [...(this.state?.todos ?? [])];
  }

  private setTodos(todos: TurnTodo[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, todos: [...todos] });
  }

  // When a new turn begins with a todo list whose items are all in terminal
  // states (completed or failed), the list no longer reflects work in progress.
  // Clear it so the user-visible todos panel resets and the next turn does not
  // carry a stale reminder forward.
  private clearFinishedTodosAtTurnStart(state: TurnState): TurnState {
    const todos = state.todos;
    if (!todos || todos.length === 0) return state;
    const hasOpen = todos.some(
      (todo) => todo.status === "pending" || todo.status === "in_progress",
    );
    if (hasOpen) return state;
    const cleared: TurnState = { ...state, todos: [] };
    this.setState(cleared);
    this.emit({ type: "todos", todos: [] });
    return cleared;
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("Turn runner has not been started.");
    }
  }

  protected requireParentAgent(): Agent {
    if (!this.parentAgent) {
      throw new Error("Turn runner parent agent has not been initialized.");
    }
    return this.parentAgent;
  }

  private initializeParentAgent(): void {
    const state = this.requireRunnerState();
    // Routing-guidance layers travel alongside the tools they describe.
    // Each tool keeps its own description lean (how to call it, what the
    // params mean) and the "when to reach for it" guidance lives here so
    // the agent learns the trigger patterns the user actually types.
    //  - state-machine layer: appended in non-`agent` modes where
    //    state-machine tools are exposed; `auto` mode is the case that
    //    matters most because the agent must decide between todo_write
    //    and create_state_machine_definition.
    //  - recall-memory layer: appended whenever durable memory persistence
    //    is wired up, so the agent reaches for `recall_memory` on
    //    cross-session questions ("what did you do yesterday", "didn't
    //    we ship X already?") instead of hedging.
    const layers = [
      state.mode === "agent"
        ? undefined
        : createStateMachineSystemPromptLayer({ mode: state.mode, session: state }),
      this.config.memoryDbPath !== undefined ? createRecallMemorySystemPromptLayer() : undefined,
      // Advisor timing guidance ships with the tool: description-only
      // steering measurably under-triggers consults on hard tasks.
      this.advisorPolicy?.enabled ? ADVISOR_EXECUTOR_GUIDANCE_LAYER : undefined,
      // Source-of-truth-first guidance always applies: even without
      // configured memory, the agent should still prefer live tools,
      // skills, and files in cwd over guessed answers.
      createSourceOfTruthSystemPromptLayer(),
    ].filter((layer): layer is string => Boolean(layer));
    const appendSystemPrompt = layers.length > 0 ? layers.join("\n\n") : undefined;
    this.parentControlResults.length = 0;
    this.parentAgent = this.createAgent(
      {
        state,
        appendSystemPrompt,
        parentModelRouting: true,
        ...(this.modelRouter ? { router: this.modelRouter } : {}),
        ...this.createTools(state.mode),
      },
      (result) => {
        this.captureParentControlResult(result);
      },
    );
    this.snapshotActiveAgentState();
  }

  private async stateMachineResultFromWorker(
    workerResult: AgentWorkerResult,
    state: TurnState,
  ): Promise<SettledDecision["outcome"] | undefined> {
    const control = workerResult.control;
    if (control.type === "none") return undefined;
    if (control.type === "ask_user_question") {
      return { type: "ask", questions: control.questions };
    }
    if (control.type === "create_state_machine_definition") {
      // A create that reaches here was authorized by the tool: it only emits
      // this control result when no machine is active OR the agent opted into
      // replaceActive. So an active, non-terminal session at this point means
      // the agent deliberately chose to replace it — supersede it (recording a
      // `cancelled` terminal) before installing the new machine in its place.
      const active = this.stateMachine;
      if (active && !active.terminal) {
        await this.replaceActiveStateTasks("Replaced by a new state machine.");
        this.setStateMachine(
          supersede(active, `Superseded by a new state machine ("${control.definition.name}").`),
          true,
        );
      }

      const firstState = control.firstState;
      this.setStateMachine(
        startStateMachineSession({
          prompt:
            workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
          definition: control.definition,
          currentState: firstState,
        }),
      );
      return this.runStateMachineDecision({ state: firstState });
    }

    if (!this.stateMachine && typeof state.mode === "object") {
      this.setStateMachine(
        startStateMachineSession({
          prompt:
            workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
          definition: state.mode as Exclude<TurnMode, "agent" | "auto">,
          currentState: control.decision.state,
        }),
      );
    }
    return this.runStateMachineDecision(control.decision);
  }

  private async runStateMachineDecision(decision: StateMachineRunnerDecision) {
    await this.replaceActiveStateTasks("Replaced by a newly selected state.");
    await this.cancelScheduledTasks("Replaced by a newly selected state.");
    const planned = planDecision(this.requireStateMachine(), decision, this.clock.now());
    this.setStateMachine(planned.session, true);
    return this.executePlannedWork(planned.work);
  }

  private async replaceActiveStateTasks(reason: string): Promise<void> {
    const active = [...this.stateTasks.entries()].filter(
      ([id]) => this.taskManager.output(id)?.descriptor.status === "running",
    );
    for (const [id, metadata] of active) {
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        { type: "interrupted", reason },
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      this.ignoredTaskSettlements.add(id);
    }
    await Promise.all(active.map(([id]) => this.taskManager.stop(id, reason)));
  }

  protected createTools(
    mode: TurnMode,
    cwdOverride?: string,
    includeParentTools = true,
    childContext?: ChildToolContext,
  ): {
    tools: AgentTool[];
  } {
    const cwd = resolveStateCwd(cwdOverride, this.config.cwd ?? process.cwd());
    const todoStorage = {
      getTodos: () => this.getTodos(),
      setTodos: (todos: TurnTodo[]) => {
        this.setTodos(todos);
        this.emit({ type: "todos", todos });
      },
    };
    const skills = this.skillContext.getSkills();
    const mcpTools = this.mcpRuntime?.tools ?? [];
    const recallStorage: RecallMemoryToolStorage = {
      getSession: () => this.memoryPersistence?.session,
      embed: this.memoryPersistence?.embed,
      sessionId: childContext?.memorySessionId ?? this.config.sessionId,
      // Reuse the resolved memory model so recall_memory's optional
      // expand flag goes to the same cheap model the observer uses.
      expansionModel: this.resolveMemoryActorModel(undefined),
    };
    const router = this.modelRouter;
    const advisorStorage =
      includeParentTools && router && this.advisorPolicy?.enabled
        ? this.createAskAdvisorStorage(router, this.advisorPolicy)
        : undefined;
    const baseTools =
      mode === "agent"
        ? createDefaultTurnRunnerTools(cwd, todoStorage, recallStorage, advisorStorage)
        : createTurnRunnerTools({
            cwd,
            mode,
            getDefinition: () => this.stateMachine?.definition,
            getStateMachine: () => this.stateMachine,
            getActiveStateOutput: () => this.getActiveStateOutput(),
            todoStorage,
            skills,
            recallStorage,
            advisorStorage,
            clock: this.clock,
            minimumScheduledDelayMs: this.minimumScheduledDelayMs,
          });
    const childSafeTools = includeParentTools
      ? baseTools
      : baseTools.filter((tool) => tool.name !== "ask_user_question");
    const taskAwareTools = childSafeTools.map((tool) =>
      tool.name === "bash"
        ? wrapBackgroundable(tool, {
            taskManager: this.taskManager,
            defaultWaitBudgetMs: this.taskWaitBudgetMs,
            clock: this.clock,
            ownerScopeId: () => childContext?.ownerScopeId ?? this.requireRootScope(),
            label: (params) => String(params.command ?? "bash command"),
            onTaskStarted: (id, foregroundPending) => {
              this.taskSettlementDelivery.set(
                id,
                foregroundPending ? "foreground_pending" : "deliver",
              );
            },
            onForegroundResult: (id, converted) => {
              this.taskSettlementDelivery.set(id, converted ? "deliver" : "suppress");
              this.scheduleSettlementDelivery();
            },
          })
        : tool,
    );
    return {
      tools: [
        ...taskAwareTools,
        ...(includeParentTools || childContext
          ? [
              this.createSpawnTool(childContext),
              ...createTaskAdminTools({ taskManager: this.taskManager, clock: this.clock }),
            ]
          : []),
        ...mcpTools,
      ],
    };
  }

  private createSpawnTool(childContext?: ChildToolContext): AgentTool {
    const ownerScopeId = () => childContext?.ownerScopeId ?? this.requireRootScope();
    return createSpawnAgentTool({
      taskManager: this.taskManager,
      defaultWaitBudgetMs: this.taskWaitBudgetMs,
      clock: this.clock,
      ownerScopeId,
      createRun: async ({ spec, taskId, ownerScopeId: callerScopeId, childScopeId }) =>
        this.createSpawnedSubagentRun(
          spec,
          taskId,
          callerScopeId,
          childScopeId,
          childContext?.forkSource,
          childContext?.modelSetting(),
        ),
      dropScratch: async (taskId) => this.dropSubagentScratch(taskId),
      onTaskStarted: (id, foregroundPending) => {
        this.taskSettlementDelivery.set(id, foregroundPending ? "foreground_pending" : "deliver");
      },
      onForegroundResult: (id, converted) => {
        this.taskSettlementDelivery.set(id, converted ? "deliver" : "suppress");
        this.scheduleSettlementDelivery();
      },
    });
  }

  protected createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const resolveAdvisorModel = () => resolveModelName(policy.target.modelName);
    return {
      getContext: async (contextWindowTokens) =>
        await this.captureContextForAdvisor(contextWindowTokens),
      resolveModel: () => {
        const model = resolveAdvisorModel();
        return {
          modelName: model.id,
          contextWindowTokens: model.contextWindow,
          acceptsImages: model.input.includes("image"),
        };
      },
      thinkingLevel: policy.target.thinkingLevel,
      advisorGate: () => router.beginAdvisorConsult(),
      noteAdvisorConsult: (success = true) => {
        router.endAdvisorConsult(success);
        if (success && this.advisorTurnLifecycle) {
          this.advisorTurnLifecycle.noteSuccessfulConsult(router.status().assistantSteps);
        }
      },
      recordUsage: (usage) => {
        const model = resolveAdvisorModel();
        this.recordAndEmitUsage(usageFromAiSdk(usage, model), model.id);
      },
      onUsageError: (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "system",
          level: "warn",
          message: `Advisor usage accounting failed; advice was retained: ${reason}`,
        });
      },
      onAdvisorError: (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "system",
          level: "warn",
          message: `Advisor consultation failed; executor continued: ${reason}`,
        });
      },
    };
  }

  /**
   * Keep ordinary advisor calls raw when already efficient. Above the soft
   * target, drain older work through the normal memory observer and project it
   * with an advisor-owned horizon so the executor's next request is unchanged.
   */
  protected async captureContextForAdvisor(
    contextWindowTokens: number,
    options: { drainObservations?: boolean } = {},
  ): Promise<AdvisorExecutorContext> {
    const agent = this.requireParentAgent();
    const rawContext = await captureAdvisorExecutorContext(agent);
    const rawRequest = buildAdvisorContext({
      context: rawContext,
      contextWindowTokens,
      reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
    });
    const inputTargetTokens = rawRequest.metadata.inputTargetTokens;
    if (
      !rawRequest.metadata.truncated &&
      rawRequest.metadata.estimatedInputTokens <= inputTargetTokens
    ) {
      return rawContext;
    }
    if (!this.memoryPersistence?.session) return rawContext;

    let recentMessageTarget = Math.min(
      ADVISOR_RECENT_MESSAGE_TARGET_TOKENS,
      Math.floor(inputTargetTokens / 2),
    );
    let projectedContext = rawContext;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      projectedContext = await captureAdvisorExecutorContext(agent, {
        transformMessages: async (messages) =>
          await compactObservationalContext({
            messages,
            memory: this.memory,
            horizon: this.advisorWireGuardHorizon,
            targetMessageTokens: recentMessageTarget,
            protectRecentToolInteraction: true,
            ...(options.drainObservations === false
              ? {}
              : {
                  onCompaction: async (observable: AgentMessage[]) =>
                    await this.ensureMemoryCoverageForCompaction(observable),
                }),
          }),
      });
      const projectedRequest = buildAdvisorContext({
        context: projectedContext,
        contextWindowTokens,
        reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      });
      const excess = projectedRequest.metadata.estimatedInputTokens - inputTargetTokens;
      if (excess <= 0) return projectedContext;
      recentMessageTarget = Math.max(1, recentMessageTarget - excess);
    }
    return projectedContext;
  }

  /**
   * Pass-prep applied to EVERY parent pass, including harness overrides of
   * `runAgentWorker` (they must call this first). One-shot reminders that must
   * reach "whatever parent pass runs next" live here.
   */
  protected prepareParentPassInput(input: AgentWorkerInput): AgentWorkerInput {
    const withheldAsk = this.withheldAskQuestions;
    this.withheldAskQuestions = undefined;
    if (!withheldAsk) return input;
    return { ...input, prompt: `${withheldAskReminder(withheldAsk)}\n\n${input.prompt}` };
  }

  protected async runAgentWorker(rawInput: AgentWorkerInput): Promise<AgentWorkerResult> {
    const input = this.prepareParentPassInput(rawInput);
    if (this.parentAgentRunning) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }

    const agent = this.requireParentAgent();
    this.applyPendingModelSelection(agent);
    agent.state.tools = this.turnTools ?? this.createTools(input.state.mode).tools;
    this.parentControlResults.length = 0;
    this.setParentAgentRunning(true);

    const unsubscribe = agent.subscribe((event) => this.emitParentAgentEvent(event));
    this.parentAgentInterrupted = false;
    try {
      if (!input.continuation) {
        this.modelRouter?.noteTurnStart({ promptHasImages: (input.images?.length ?? 0) > 0 });
      }
      const switched = await this.modelRouter?.prepareTurn({
        prevTurnHint: input.prompt,
        signal: agent.signal,
      });
      if (switched) await this.applyRouterSwitch(agent, switched);
      await agent.prompt(input.prompt, input.images);
      // Single-shot recovery: if the provider rejected the first attempt
      // with a context-overflow error, advance the sticky wire-shaping
      // horizon so the next send carries roughly the newer half of
      // history, then resume the same turn via `agent.continue()`.
      // Continuing (rather than re-prompting) keeps the existing user
      // message at the tail instead of appending a duplicate. A
      // still-too-big second attempt falls through as `failed` — no
      // further retries.
      if (await this.tryRecoverFromContextOverflow(agent)) {
        await agent.continue();
      }
      await this.retryTransientServerErrors(agent);
    } catch (error) {
      if (!this.parentAgentInterrupted) {
        throw error;
      }
    } finally {
      unsubscribe();
      this.setParentAgentRunning(false);
    }

    if (this.parentAgentInterrupted) {
      return {
        control: this.consumeParentControlResult(),
        outcome: { type: "interrupted", state: this.requireRunnerState() },
      };
    }

    const messages = agent.state.messages;
    const status = agent.state.errorMessage ? "failed" : "completed";
    const live = this.state;
    const state = {
      ...input.state,
      status,
      agent: {
        ...input.state.agent,
        status,
        messages,
      },
      todos: live?.todos ?? input.state.todos,
      followUpQueue: live?.followUpQueue ?? input.state.followUpQueue,
      tasks: live?.tasks ?? input.state.tasks,
      nextTaskId: live?.nextTaskId ?? input.state.nextTaskId,
    } satisfies TurnState;
    return {
      control: this.consumeParentControlResult(),
      outcome: {
        type: "complete",
        status,
        state,
        result: assistantText(messages),
        error: agent.state.errorMessage,
      },
    };
  }

  private setParentAgentRunning(running: boolean): void {
    this.parentAgentRunning = running;
    this.snapshotActiveAgentState();
  }

  /**
   * Inspect the most recent assistant message after a parent prompt and,
   * when it carries a provider context-overflow error, mutate the agent
   * state and the sticky `wireGuardHorizon` so that a subsequent re-prompt
   * sends roughly the newer half of observable history.
   *
   * Returns `true` only when recovery actually happened — meaning the
   * horizon advanced past at least one observable message. Callers use
   * the return value as a single-shot gate: invoke once after the first
   * `agent.prompt(...)` and, on `true`, resume the turn via
   * `agent.continue()` exactly once. The helper never inspects the
   * failing message again, so a second overflow on the retry falls
   * through naturally as a `failed` turn.
   *
   * Mutations on success:
   * - pops the failure assistant message that pi-agent pushed for the
   *   overflow (an empty-text marker with `stopReason: "error"` and
   *   `errorMessage`) so the retry's transcript does not carry it.
   *   `agent.continue()`'s own run lifecycle resets `errorMessage`
   *   before the retry, so we do not clear it here;
   * - advances `this.wireGuardHorizon.evictionHorizon` to the smallest
   *   value at which `findEvictionHorizon` reports the dispatched list
   *   shrinks to at most `floor(n / 2)` observable messages, where `n`
   *   excludes the failure message itself.
   *
   * Emits one informational `system` event describing the compaction so
   * surfaces can show a notice. The message reports the *actual*
   * post-eviction drop count (after `MIN_HISTORY_TAIL` clamping and
   * orphan-head skipping), not the half-of-n target.
   *
   * Returns `false` when:
   * - the parent agent did not fail (`errorMessage` is unset);
   * - the failure is not a context overflow (rate limit, transport
   *   error, etc. — left as-is for the caller to surface);
   * - no horizon advance is possible (e.g. the existing horizon already
   *   covers every evictable message, or the history is too short to
   *   satisfy `MIN_HISTORY_TAIL`). In those cases retrying with the
   *   same context would still overflow, so we accept the failure
   *   instead of paying a second pointless request.
   */
  protected async tryRecoverFromContextOverflow(agent: Agent): Promise<boolean> {
    if (!agent.state.errorMessage) return false;
    const messages = agent.state.messages;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    if (!isContextOverflow(lastMessage, agent.state.model.contextWindow)) return false;

    // Exclude the failure assistant message from the half-history
    // calculation; only "real" prior turns should count toward the
    // observable population the cut targets.
    const observable = stripObservationalContextMessages(messages.slice(0, -1));
    const target = Math.floor(observable.length / 2);
    const previousHorizon = this.wireGuardHorizon.evictionHorizon;
    await this.ensureMemoryCoverageForCompaction(observable);
    const newHorizon = findEvictionHorizon(
      observable,
      previousHorizon,
      (candidate) => candidate.length <= target,
    );
    if (newHorizon === previousHorizon) return false;

    messages.pop();
    this.wireGuardHorizon.evictionHorizon = newHorizon;
    this.modelRouter?.noteCompaction();

    const remaining = applyEvictionHorizon(observable, newHorizon).length;
    const dropped = observable.length - remaining;
    this.emit({
      type: "system",
      level: "info",
      message: `Context overflow: dropped ${dropped} older message${dropped === 1 ? "" : "s"} and retrying.`,
    });
    return true;
  }

  /**
   * Retry transient upstream failures by popping the failed assistant
   * message and continuing the same turn.
   *
   * Triggers only when the last assistant message has `stopReason: "error"`
   * and the error text matches a known gateway 5xx or transport-fault
   * pattern (see `transient-error.ts`). Context-overflow recoveries already
   * ran upstream and are skipped here; 4xx errors and rate limits are
   * intentionally not retried because the same payload would fail again.
   *
   * Each `agent.continue()` retry runs with exponential backoff + jitter.
   * Each retry emits an informational `system` event so callers can show
   * "retrying after upstream error" in the UI. The retry counter resets
   * whenever the agent makes forward progress between failures — if
   * `agent.continue()` appends a successful intermediate message before
   * the next failure tail, the next failure is treated as a fresh
   * sequence and gets the full retry budget. As soon as the assistant
   * message after a retry is no longer a transient failure (success or
   * a different non-retryable error), the helper returns and lets the
   * caller surface that outcome.
   *
   * The loop has no explicit iteration cap because every iteration
   * either reaches `maxAttempts` with no progress (terminates) or
   * resets after real agent work (tool calls, tokens, bounded by
   * pi-agent's own per-turn limits). A provider that can sustain
   * infinite "progress + failure" cycles would already be billing the
   * caller for real work each cycle — there is no free loop here.
   */
  protected async retryTransientServerErrors(
    agent: Agent,
    policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY_POLICY,
  ): Promise<void> {
    let attempt = 1;
    while (attempt < policy.maxAttempts) {
      if (!agent.state.errorMessage) return;
      if (!lastMessageIsTransientFailure(agent.state.messages)) return;
      const failingMessage = agent.state.messages.at(-1);
      const reason =
        failingMessage?.role === "assistant" && failingMessage.errorMessage
          ? failingMessage.errorMessage
          : "Upstream error";
      const delayMs = transientRetryDelayMs(attempt, policy);
      this.emit({
        type: "system",
        level: "info",
        message: `Upstream error (${truncateForSystemMessage(reason)}); retrying in ${Math.round(delayMs / 100) / 10}s (attempt ${attempt + 1}/${policy.maxAttempts}).`,
      });
      // pi-agent leaves the failure as the tail assistant message and
      // keeps `errorMessage` set; popping it lets `agent.continue()`
      // resume from the prior user/tool-result tail without sending the
      // failure marker back to the provider.
      agent.state.messages.pop();
      const lengthBeforeContinue = agent.state.messages.length;
      await sleep(delayMs);
      await agent.continue();
      // If `continue()` appended more than just a new failure tail
      // (i.e. at least one intermediate assistant or tool message
      // landed before the agent failed again), the agent made real
      // progress between failures. Reset so the next failure gets a
      // fresh retry budget instead of inheriting the running count.
      const messagesAppended = agent.state.messages.length - lengthBeforeContinue;
      attempt = messagesAppended > 1 ? 1 : attempt + 1;
    }
  }

  protected async updateMemoryAfterAgentRun(
    messages: AgentMessage[],
    options: TurnOptions | undefined,
    sessionId = this.config.sessionId,
    refreshReflections = true,
  ): Promise<void> {
    if (this.config.memoryDbPath === undefined) {
      return;
    }
    const session = this.memoryPersistence?.session;
    if (!session) return;
    // The observer takes the model name and resolves it internally, but usage
    // is attributed by resolved id so the memory slice matches the parent and
    // state-agent entries in `usageByModel` (e.g. `openai/gpt-5.4-mini`) rather
    // than mixing a shorthand in among resolved ids.
    const memoryModel = this.resolveMemoryActorModel(options);
    const memoryModelId = resolveModelName(memoryModel).id;
    const result = await updateObservationalMemory({
      session,
      memory: this.memory,
      sessionId,
      effectiveContext: this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      actorModel: memoryModel,
      settings: this.config.memory,
      messages,
      cwd: this.config.cwd ?? process.cwd(),
      // Observation/reflection work is part of the turn's cost. Fold it into
      // the aggregate and emit a `usage` event so memory spend streams like
      // every completion does — and so the last streamed event still equals
      // the terminal aggregate even though memory runs after the parent's
      // final `message_end`.
      onUsage: (usage) => {
        this.recordUsage(usage, memoryModelId);
        this.emitTurnUsage();
      },
      onActivity: (event) => this.emit({ type: "memory", ...event }),
    });

    // Compaction trigger: a reflection just replaced the durable
    // observation set, so rebuild the frozen context pack to pick up
    // the new condensed view. Observer-only updates intentionally do
    // NOT refresh the pack — they leave the rendered prefix stable so
    // the provider's prompt cache survives.
    if (refreshReflections && result.reflections.length > 0) {
      await this.refreshMemoryContextPack();
    }
  }

  /**
   * Drain the unobserved tail into durable memory and refresh the
   * frozen context pack so the post-eviction render carries an
   * `<observation-group range=“…”>` covering what is about to be
   * dropped. Called from every `findEvictionHorizon` site — the
   * wire-shaping transform's `onCompaction`, `/compact`, and the
   * context-overflow recovery path — so each one writes through the
   * same observer with the same best-effort failure policy: a failed
   * drain logs a `system` warning and eviction proceeds anyway.
   *
   * Actor model resolution always uses the session config default
   * (`config.memoryModel → DEFAULT_CLI_MEMORY_MODEL`) so every
   * compaction path writes through the same observer regardless of
   * which entry point triggered it. `/compact` does not honor a
   * per-turn `--memory-model` override here — that override only
   * affects the agent's reply, not the drain.
   */
  private async ensureMemoryCoverageForCompaction(messages: AgentMessage[]): Promise<void> {
    try {
      await this.updateMemoryAfterAgentRun(messages, undefined);
    } catch (error) {
      this.emit({
        type: "system",
        level: "warn",
        message: `compact: observation drain failed (${truncateForSystemMessage(
          error instanceof Error ? error.message : String(error),
        )}); evicting anyway.`,
      });
    }
    await this.refreshMemoryContextPack();
  }

  private async refreshMemoryContextPack(): Promise<void> {
    const session = this.memoryPersistence?.session;
    if (!session) return;
    try {
      await rebuildMemoryContextPack({
        session,
        cache: this.memory,
        settings: resolveObservationalMemorySettings(
          this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
          this.config.memory,
        ),
        ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
      });
    } catch {
      // Pack rebuild is best-effort; the existing pack remains in
      // place if this fails. Turn flow never blocks on memory work.
    }
  }

  /**
   * Memory model precedence: per-turn override → runner config → default.
   * Exposed as a method so tests can verify the exact fallback chain that the
   * memory observer ends up using.
   */
  resolveMemoryActorModel(options: TurnOptions | undefined): string {
    return options?.memoryModel ?? this.config.memoryModel ?? DEFAULT_CLI_MEMORY_MODEL;
  }

  protected createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const options = this.resolveTurnOptions(undefined, input.state.options);
    const initialRoute = input.router?.initialTarget({ hasImages: false });
    const model = resolveModelName(initialRoute?.modelName ?? options.model ?? DEFAULT_CLI_MODEL);
    // Parent agent configuration is derived from start/session options, not
    // per-prompt command options. For concrete selections the model stays
    // stable for the whole session to protect prompt caching; routed sessions
    // deliberately trade cache prefixes away when the ModelRouter swaps the
    // model (per turn or via prepareNextTurn), with the classifier prompt
    // carrying the don't-switch-mid-task cache preference.
    let agent!: Agent;
    agent = new Agent({
      initialState: {
        model,
        thinkingLevel: initialRoute?.thinkingLevel ?? options.thinkingLevel ?? "medium",
        systemPrompt:
          input.systemPrompt ??
          this.createBaseSystemPromptWithAppendedLayers({
            prepend: [input.prependSystemPrompt],
            append: [input.appendSystemPrompt],
            skills: input.skills,
          }),
        messages: input.state.agent.messages,
        tools: input.tools,
      },
      transformContext: this.createMemoryTransform(input.memoryContext),
      ...(input.parentModelRouting
        ? {
            prepareNextTurn: async (signal?: AbortSignal) => {
              const switched = await this.modelRouter?.prepareTurn({
                signal,
              });
              return switched ? await this.applyRouterSwitch(agent, switched) : undefined;
            },
          }
        : {}),
      steeringMode: "all",
      toolExecution: "parallel",
      afterToolCall: async (context) => {
        const details = context.result.details;
        if (isTurnRunnerControlResult(details)) {
          onControlResult?.(details);
        }
        return undefined;
      },
      getApiKey: resolveProviderApiKey,
    });
    return agent;
  }

  protected createMemoryTransform(memoryContext?: SubagentAgentConfigInput["memoryContext"]) {
    // The memory transform owns history retention against both the token
    // budget (context-window cost on smaller models) and the wire-byte
    // budget (gateway request-body caps). It applies the sticky horizon
    // first so subsequent turns reuse the same eviction decision and the
    // provider prompt cache stays valid between eviction events.
    return createObservationalContextTransform({
      memory: this.memory,
      effectiveContext: () =>
        this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      settings: this.config.memory,
      horizon: memoryContext?.horizon ?? this.wireGuardHorizon,
      onCompaction: async (messages) => {
        if (memoryContext) {
          try {
            await this.updateMemoryAfterAgentRun(
              messages,
              undefined,
              memoryContext.sessionId,
              false,
            );
          } catch (error) {
            this.emit({
              type: "system",
              level: "warn",
              message: `compact: child observation drain failed (${truncateForSystemMessage(
                error instanceof Error ? error.message : String(error),
              )}); evicting anyway.`,
            });
          }
          return;
        }
        await this.ensureMemoryCoverageForCompaction(messages);
        this.modelRouter?.noteCompaction();
      },
    });
  }

  // Sticky across all turns within this runner instance. Resets on
  // session resume (new runner). Mutated in place by the memory transform
  // when either the token or byte budget triggers eviction, and by
  // `runAgentWorker` on a provider context-overflow error so the retry
  // sends the newer half of history.
  protected readonly wireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  /** Sticky only for repeated advisor projections; never persisted into executor state. */
  protected readonly advisorWireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkills();
  }

  /**
   * Re-discover installed skills and curated memory stores from disk. Surfaces
   * newly added skills or edited memory files without restarting the runner.
   * Callers typically pair this with `getSkills()` to refresh their
   * autocomplete catalog.
   */
  async reloadSkills(): Promise<readonly Skill[]> {
    await this.skillContext.reload();
    await this.refreshPinnedStoreContextPack();
    return this.skillContext.getSkills();
  }

  /** System-prompt files (AGENTS.md by default) that resolved on disk for this session. */
  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getResolvedAgentFiles();
  }

  /** Skill name collisions where one definition shadowed another during discovery. */
  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkillCollisions();
  }

  getSkillInstructions(skillId: string): string {
    return this.skillContext.getSkillInstructions(skillId);
  }

  private async ensureSkillsLoaded(): Promise<void> {
    await this.skillContext.ensureLoaded();
  }

  /**
   * Connect to remote MCP servers exactly once per session. Subsequent starts
   * (e.g. resumed sessions) reuse the existing runtime so tool identity stays
   * stable. The runtime is disposed in dispose().
   */
  private async ensureMcpServersConnected(servers: TurnStartCommand["mcpServers"]): Promise<void> {
    if (this.mcpRuntime || !servers || Object.keys(servers).length === 0) return;
    this.mcpRuntime = await connectMcpServers(servers);
  }

  private async ensureMemoryLoaded(): Promise<void> {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;

    // Embedding client is built once per runner so connection reuse
    // amortizes TLS setup across both the backfill worker and the
    // recall_memory tool. The client lazily resolves DUET_API_KEY per
    // call so a `duet login` mid-session lights up retrieval without
    // a runner restart.
    //
    // The file-backed pack loads alongside the database-backed pack so the
    // first dispatched turn sees both frozen layers. Later database compaction
    // triggers refresh only observations; explicit skills reload refreshes the
    // file-backed layer.
    const pinnedStoreLoad = this.refreshPinnedStoreContextPack();
    this.memoryPersistence = await loadStoredMemory(
      this.config.memoryDbPath,
      this.config.cwd ?? process.cwd(),
      {
        embed: createEmbeddingClient(),
        contextPack: {
          cache: this.memory,
          settings: resolveObservationalMemorySettings(
            this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
            this.config.memory,
          ),
          ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
        },
        // Surface quarantine recoveries to the UI. The directory is moved
        // aside on the user's disk and a fresh database is opened in its
        // place, so prior memories are gone from this session's recall
        // until the user manually inspects the backup — without a system
        // event the loss is silent.
        onWarn: (message) => {
          // Cross-process lock contention: a concurrent duet CLI held the
          // memory db's open-lock past our wait budget, so this op was
          // skipped. Surface once per occurrence so the user knows recall
          // and observer writes are degraded for this turn.
          this.emit({ type: "system", level: "warn", message });
        },
        onRecover: ({ backupPath, cause }) => {
          const reason = cause instanceof Error ? cause.message || cause.name : String(cause);
          this.emit({
            type: "system",
            level: "warn",
            message: `memory.db could not be opened (${reason}); quarantined to ${backupPath} and starting fresh.`,
          });
        },
      },
    );
    await pinnedStoreLoad;
  }

  /** Reload the frozen file-backed layer without touching database memory. */
  private async refreshPinnedStoreContextPack(): Promise<void> {
    if (this.config.memoryStores === false) {
      this.memory.setStoredContextPack([]);
      return;
    }
    try {
      const base = this.config.cwd ?? process.cwd();
      // Explicit entries may be relative; resolve them against the configured
      // cwd like relative db and system-prompt paths, not the process cwd.
      const stores = this.config.memoryStores
        ? this.config.memoryStores.map((store) => resolve(base, store))
        : await discoverMemoryStores(base);
      await rebuildPinnedStoreContextPack({ stores, cache: this.memory });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[duet-agent] failed to load pinned memory stores: ${reason}`);
    }
  }

  protected createBaseSystemPromptWithAppendedLayers(input?: {
    prepend?: Array<string | undefined>;
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return this.skillContext.createSystemPromptWithAppendedLayers(input);
  }

  /**
   * Single source of truth for per-turn option precedence:
   * explicit turn options → carried-over state base → runner config → defaults.
   */
  resolveTurnOptions(options?: TurnOptions, base?: TurnOptions): TurnOptions {
    return {
      model: options?.model ?? base?.model ?? this.config.model ?? DEFAULT_CLI_MODEL,
      memoryModel:
        options?.memoryModel ??
        base?.memoryModel ??
        this.config.memoryModel ??
        DEFAULT_CLI_MEMORY_MODEL,
      thinkingLevel: options?.thinkingLevel ?? base?.thinkingLevel ?? this.config.thinkingLevel,
    };
  }

  protected recordUsage(usage?: TurnTokenUsage | Usage, modelId?: string): void {
    this.turnUsage = addUsage(this.turnUsage, usage);
    if (usage && modelId) {
      this.turnUsageByModel = addUsageByModel(this.turnUsageByModel, modelId, usage);
    }
  }

  /** Attribute a non-parent model call and publish it once a flat context snapshot exists. */
  private recordAndEmitUsage(usage: TurnTokenUsage | Usage, modelId: string): void {
    this.recordUsage(usage, modelId);
    this.emitTurnUsage();
  }

  protected emitAgentEvent(event: AgentEvent, origin?: TurnEventOrigin): void {
    if (event.type === "message_start" && event.message.role === "user") {
      this.removeFollowUpPrompt(agentMessageText(event.message));
    }
    for (const turnEvent of this.agentEventToTurnEvents(event)) {
      this.emit(origin ? { ...turnEvent, origin } : turnEvent);
    }
  }

  protected emitParentAgentEvent(event: AgentEvent): void {
    this.emitAgentEvent(event);
    if (event.type === "turn_end" && event.message.role === "assistant") {
      this.modelRouter?.noteAssistantStep(routerStepObservation(event.message, event.toolResults));
      this.advisorTurnLifecycle?.noteExecutedTools(
        event.toolResults.map((result) => result.toolName),
      );
      this.steerAdvisorOrientationIfDue();
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    // Cache the parent's latest bar/breakdown so subsequent state-agent and
    // terminal emissions can reuse it without rescaling against a stale base.
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: this.effectiveContextWindow(),
      contextWindowUsage: scaleContextWindowUsageToTotalTokens(
        this.estimateContextWindowUsage(),
        event.message.usage.totalTokens,
      ),
      lastMessageUsage: event.message.usage,
    };

    // A turn is a loop of completion calls; fold this completion's usage into
    // the running aggregate and emit a `usage` event now so a tool-heavy turn
    // ticks cost per completion. This is the only place a real parent run
    // records usage — a completion only ticks a `usage` event when it actually
    // consumed tokens, so a rejected attempt (e.g. a provider context-overflow
    // error the turn then recovers from) carries no usage and would otherwise
    // emit a degenerate all-zero bar.
    this.recordUsage(event.message.usage, event.message.model);
    if (event.message.usage.totalTokens > 0) this.emitTurnUsage();
  }

  /** Deliver one in-transcript orientation checkpoint without changing the public protocol. */
  private steerAdvisorOrientationIfDue(): void {
    const lifecycle = this.advisorTurnLifecycle;
    const routeStatus = this.modelRouter?.status();
    if (
      !lifecycle ||
      !routeStatus ||
      !lifecycle.takeOrientationCheckpoint(routeStatus.assistantSteps)
    ) {
      return;
    }
    this.requireParentAgent().steer(
      buildUserAgentMessage(systemReminder(ADVISOR_ORIENTATION_REMINDER), undefined),
    );
  }

  /**
   * Re-emit the context-window breakdown after `compact()` advances the
   * eviction horizon. The bar's numerator is the latest parent
   * `lastMessageUsage.totalTokens`, which still reflects the pre-compact
   * wire tail; we re-estimate the per-segment occupancy against the new
   * horizon, sum it for a synthetic total, and proportionally rescale the
   * snapshot's `lastMessageUsage` so the bar moves immediately. The
   * snapshot is updated in place so a follow-up state-agent emission
   * before the next parent message_end keeps reading the post-compact
   * shape instead of jittering back to stale values.
   */
  private emitPostCompactUsage(): void {
    if (!this.lastParentUsageSnapshot) return;
    const rawBreakdown = this.estimateContextWindowUsage();
    const newTotal =
      rawBreakdown.systemPrompt +
      rawBreakdown.messages +
      rawBreakdown.localMemory +
      rawBreakdown.globalMemory;
    const prior = this.lastParentUsageSnapshot.lastMessageUsage;
    const priorTotal = Math.max(1, prior.totalTokens);
    const ratio = newTotal / priorTotal;
    const scale = (value: number) => Math.max(0, Math.round(value * ratio));
    const refreshedMessageUsage: TurnTokenUsage = {
      input: scale(prior.input),
      output: scale(prior.output),
      cacheRead: scale(prior.cacheRead),
      cacheWrite: scale(prior.cacheWrite),
      totalTokens: newTotal,
      // Cost is historical: the provider already billed for the
      // pre-compact call, so we leave it intact rather than fabricating a
      // smaller cost the user was never charged.
      cost: prior.cost,
    };
    const refreshedContextWindowUsage = scaleContextWindowUsageToTotalTokens(
      rawBreakdown,
      newTotal,
    );
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: refreshedContextWindowUsage,
      lastMessageUsage: refreshedMessageUsage,
    };
    // `compact()` only runs between turns, so `this.turnUsage` is
    // undefined here; emit a zero aggregate so `Session.applyUsageEvent`
    // can still refresh `lastUsage`. Session cost was already credited
    // at the prior terminal, so a zero `turnUsage.cost.total` does not
    // lose any spend.
    const turnUsage = this.turnUsage ?? emptyTokenUsage();
    this.emit({
      type: "usage",
      turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      lastMessageUsage: refreshedMessageUsage,
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: refreshedContextWindowUsage,
    });
  }

  /**
   * Emit a `usage` event reflecting the latest `this.turnUsage`. Reuses the
   * most recent parent context-window snapshot for the bar/breakdown so
   * mid-turn ticks (parent worker finish, state-agent finish) surface cost
   * without jittering the parent context fields. Before the first parent
   * completion, usage is recorded for the terminal and the first later usage
   * event, but no incomplete wire event is emitted.
   */
  protected emitTurnUsage(origin?: TurnEventOrigin): void {
    if (!this.turnUsage || !this.lastParentUsageSnapshot) return;
    this.emit({
      type: "usage",
      turnUsage: this.turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
      ...(origin ? { origin } : {}),
    });
  }

  /**
   * Estimate the per-segment occupancy of the parent agent's input before
   * reconciliation with provider `totalTokens`. System prompt and memory
   * packs use the same `ceil(chars / CHARS_PER_TOKEN)` heuristic as the memory pipeline so
   * compaction triggers stay on the same scale as `MEMORY_BUDGET_RATIOS`.
   *
   * The message tail uses {@link calculateWireTokens} over the
   * post-eviction slice — the same slice the provider tokenized — so
   * messages already dropped by wire-shaping stop counting against the
   * `messages` segment instead of inflating it from the runner's full
   * retained transcript. Text and structured blocks (`toolCall`, thinking,
   * etc.) use `ceil(chars / CHARS_PER_TOKEN)`, and image blocks contribute a fixed
   * per-image estimate rather than their base64 byte length.
   *
   * `emitParentAgentEvent` rescales all four segments with
   * {@link scaleContextWindowUsageToTotalTokens} so the emitted breakdown
   * sums exactly to the API-reported `usage.totalTokens`.
   */
  protected estimateContextWindowUsage() {
    const agent = this.requireParentAgent();
    const pack = this.memory.getContextPack();
    const dispatched = applyEvictionHorizon(
      agent.state.messages,
      this.wireGuardHorizon.evictionHorizon,
    );
    const messageWireTokens = calculateWireTokens(dispatched);
    return {
      systemPrompt: estimateTokens(agent.state.systemPrompt),
      messages: messageWireTokens,
      localMemory: pack.local.reduce((total, row) => total + estimateTokens(row.content), 0),
      globalMemory: [...pack.stored, ...pack.global].reduce(
        (total, row) => total + estimateTokens(row.content),
        0,
      ),
    };
  }

  /**
   * Effective ceiling for the context-usage bar. The user-set
   * `config.effectiveContext` (default `DEFAULT_EFFECTIVE_CONTEXT`) is clamped
   * to the parent model's hard window so a user asking for more than the
   * model can fit silently caps at the model's limit. Every memory budget is
   * derived from this same number, so the bar is also the practical
   * compaction ceiling.
   */
  protected effectiveContextWindow(): number {
    const modelWindow = this.requireParentAgent().state.model.contextWindow;
    return this.resolveEffectiveContext(modelWindow);
  }

  /**
   * Resolve the user-set `effectiveContext` against an optional model window.
   * Memory-pipeline callers that run before the parent agent exists (initial
   * pack load, transform construction) pass `undefined` here and accept the
   * unclamped user value; the agent-facing `effectiveContextWindow()` always
   * passes the live model window.
   */
  protected resolveEffectiveContext(modelWindow?: number): number {
    const userValue = this.config.effectiveContext ?? DEFAULT_EFFECTIVE_CONTEXT;
    return modelWindow !== undefined ? Math.min(userValue, modelWindow) : userValue;
  }

  /** Load the project table and build the parent router when the persisted selection is virtual. */
  private async initializeModelRouter(modelName: string | undefined): Promise<void> {
    this.modelRouter = undefined;
    this.routingTable = undefined;
    this.advisorPolicy = undefined;
    const loaded = await loadRoutingTable({
      cwd: this.config.cwd ?? process.cwd(),
      catalogAdapter: routingCatalogAdapter,
    });
    this.routingTable = loaded.table;
    if (!modelName || !isVirtualModel(modelName, loaded.table)) return;
    this.advisorPolicy = loaded.table.tiers[modelName]!.advisor;
    this.modelRouter = this.createBoundModelRouter(modelName, loaded.table, routingCatalogAdapter);
  }

  private createBoundModelRouter(
    tier: string,
    table: RoutingTable,
    resolveCatalog: RouteResolutionCatalog,
  ): ModelRouter {
    return this.createModelRouter({
      table,
      tier,
      classify: async (input, signal) => {
        return classifyRoute(input, { ...this.classifierOptions(table), signal });
      },
      resolveCatalog,
    });
  }

  /** One metered classifier contract shared by parent routing and spawned children. */
  private classifierOptions(table: RoutingTable): ClassifyRouteOptions {
    const model = resolveModelName(table.classifier.target.modelName);
    return {
      model: `${model.provider}:${model.id}`,
      thinkingLevel: table.classifier.target.thinkingLevel,
      onUsage: (usage) => this.recordAndEmitUsage(usage, model.id),
    };
  }

  /** True when a model name is owned by the validated project table. */
  isVirtualModelSelection(modelName: string): boolean {
    return isVirtualModel(modelName, this.routingTable ?? BUILT_IN_ROUTING_TABLE);
  }

  /** Read-only routing snapshot for session-owned UI surfaces. */
  routeStatus(): RouterStatus | undefined {
    return this.modelRouter?.status();
  }

  /**
   * Retarget subsequent parent turns while preserving the current in-flight turn.
   * Concrete selections pin routing; virtual selections rebuild it so the next
   * turn classifies from a fresh tier-local baseline.
   */
  setModel(modelName: string): { routed: boolean } {
    const routed = this.isVirtualModelSelection(modelName);
    if (!routed) resolveModelName(modelName);
    const state = this.requireRunnerState();
    state.options = { ...state.options, model: modelName };
    this.pendingModelSelection = modelName;
    if (!this.parentAgentRunning) this.applyPendingModelSelection(this.requireParentAgent());
    return { routed };
  }

  private applyPendingModelSelection(agent: Agent): void {
    const selection = this.pendingModelSelection;
    if (!selection) return;
    this.pendingModelSelection = undefined;
    if (!this.isVirtualModelSelection(selection)) {
      this.modelRouter?.pin();
      this.advisorPolicy = undefined;
      agent.state.model = resolveModelName(selection);
      return;
    }

    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    this.modelRouter?.unpin();
    this.advisorPolicy = table.tiers[selection]!.advisor;
    this.modelRouter = this.createBoundModelRouter(selection, table, routingCatalogAdapter);
    const initial = this.modelRouter.initialTarget({ hasImages: false });
    agent.state.model = resolveModelName(initial.modelName);
    agent.state.thinkingLevel = initial.thinkingLevel;
  }

  /** Explicit virtual state models take the tier's default route without classifier latency. */
  private resolveStateModel(modelName: string | undefined) {
    if (!modelName || !this.isVirtualModelSelection(modelName)) return undefined;
    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    return resolveTierDefault(table, modelName, { hasImages: false }, routingCatalogAdapter);
  }

  /** Omitted child models inherit the parent's active concrete target, not its virtual setting. */
  private resolveSubagentInheritedOptions(): TurnOptions {
    const options = { ...this.requireRunnerState().options };
    if (!options.model || !this.isVirtualModelSelection(options.model)) return options;
    const parent = this.requireParentAgent().state;
    return {
      ...options,
      model: `${parent.model.provider}:${parent.model.id}`,
      ...(parent.thinkingLevel === "off" ? {} : { thinkingLevel: parent.thinkingLevel }),
    };
  }

  /** Composition seam used by production binding and deterministic runner tests. */
  protected createModelRouter(options: ModelRouterOptions): ModelRouter {
    return new ModelRouter(options);
  }

  /** Resolve and atomically apply one router-owned model/effort change. */
  private async applyRouterSwitch(agent: Agent, switched: RouterSwitch) {
    const model = resolveModelName(switched.toModel);
    agent.state.model = model;
    agent.state.thinkingLevel = switched.thinkingLevel;
    if (this.lastParentUsageSnapshot) {
      this.lastParentUsageSnapshot = {
        ...this.lastParentUsageSnapshot,
        effectiveContextWindow: this.resolveEffectiveContext(model.contextWindow),
      };
    }
    this.emit({ type: "router_switch", ...switched });
    return { model, thinkingLevel: switched.thinkingLevel };
  }
}

const ROUTER_STEP_TEXT_LIMIT = 2_000;

function routerStepObservation(
  message: Extract<AgentMessage, { role: "assistant" }>,
  toolResults: Extract<AgentEvent, { type: "turn_end" }>["toolResults"],
): StepObservation {
  const content = [...message.content, ...toolResults.flatMap((result) => result.content)];
  const text = content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => stripSystemReminders(block.text))
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    blockTypes: content.map((block) => block.type),
    text: text.slice(-ROUTER_STEP_TEXT_LIMIT),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cap an upstream-error excerpt to a short, single-line form before emitting
 * it as a `system` info message. Provider error payloads can be several
 * kilobytes of JSON; clipping keeps the retry notice readable.
 */
function truncateForSystemMessage(message: string, limit = 160): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  if (flattened.length <= limit) return flattened;
  return `${flattened.slice(0, limit - 1)}…`;
}

/** Convert protocol-level prompt images into pi-ai `ImageContent` blocks. */
function promptImagesToContent(images: TurnPromptImage[] | undefined): ImageContent[] {
  if (!images) return [];
  return images.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mimeType,
  }));
}

/**
 * Build a pi-agent user message from a prompt's text and optional images.
 * Plain-text prompts use the simple string-content shape; multimodal prompts
 * become a content array with the text part first and image blocks after.
 */
function buildUserAgentMessage(
  message: string,
  images: TurnPromptImage[] | undefined,
): {
  role: "user";
  content: string | ({ type: "text"; text: string } | ImageContent)[];
  timestamp: number;
} {
  const imageContent = promptImagesToContent(images);
  const content =
    imageContent.length > 0 ? [{ type: "text" as const, text: message }, ...imageContent] : message;
  return { role: "user", content, timestamp: Date.now() };
}
