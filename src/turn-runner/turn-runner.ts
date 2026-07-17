import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import { resolveProviderApiKey } from "../model-resolution/duet-gateway.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";

import { assistantText } from "../core/serializer.js";
import { classifyRoute } from "../model-routing/classifier.js";
import { loadRoutingTable } from "../model-routing/loader.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouterSwitch,
} from "../model-routing/router.js";
import { isVirtualModel, type AdvisorPolicy } from "../model-routing/table.js";
import { scheduledStateFallbackWakeAt } from "./duration.js";
import { toXML } from "../lib/xml.js";
import {
  createObservationalContextTransform,
  DEFAULT_EFFECTIVE_CONTEXT,
  estimateTokens,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
  updateObservationalMemory,
} from "../memory/observational.js";
import { rebuildMemoryContextPack } from "../memory/context-pack.js";
import { createEmbeddingClient } from "../memory/embedding.js";
import {
  loadStoredMemory,
  readSessionObservations,
  type MemoryPersistenceHandle,
} from "../memory/storage.js";
import { MemoryContextCache } from "../memory/store.js";
import {
  DEFAULT_CLI_MEMORY_MODEL,
  DEFAULT_CLI_MODEL,
  resolveModelName,
} from "../model-resolution/resolver.js";
import { isKnownShorthand } from "../model-resolution/catalog.js";
import type { TurnRunnerConfig } from "../types/config.js";
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
  createForkContextReminder,
  createStateAgentSystemPromptLayer,
  createStateMachineSystemPromptLayer,
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
} from "./tools.js";
import { connectMcpServers, type McpRuntime } from "./mcp.js";
import { SkillContext } from "./skill-context.js";
import {
  currentScheduledState,
  isAwaitingUserAnswer,
  isWaitingOnScheduledState,
  repeatedSelectionLoopCount,
} from "./state-machine-session.js";
import {
  StateMachineController,
  type StateAgentHandle,
  type StateAgentResult,
  type StateMachineExecutionResult,
} from "./state-machine-controller.js";
import { completeTurn, copyOptionalArray, createInitialTurnState } from "./turn-state.js";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
  type TransientRetryPolicy,
} from "./transient-error.js";
import { addUsage, addUsageByModel, usageFromMessages } from "./usage-accounting.js";

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  /**
   * Optional image attachments forwarded to `agent.prompt(text, images)`.
   * Only the parent prompt path carries images; state-machine sub-agents and
   * answer commands ignore them because their prompts are runner-synthesized.
   */
  images?: ImageContent[];
}

export interface AgentConfigInput {
  state: TurnState;
  /** System-prompt layer placed before the host systemInstructions; see createSystemPromptWithAppendedLayers. */
  prependSystemPrompt?: string;
  appendSystemPrompt?: string;
  /** Reuse an existing rendered system prompt verbatim instead of rebuilding it from layers. */
  systemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
  /** Parent-only virtual-model runtime; state agents omit it and keep their existing path. */
  router?: ModelRouter;
}

/**
 * Internal outcome of a single `runAgentWorker` call. Narrower than the
 * public `TurnTerminalEvent`: a worker only produces `complete` or
 * `interrupted`. `ask` is synthesized later from `control`; `sleep` is
 * synthesized by the state-machine controller.
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

/**
 * How many times the parent is re-prompted to emit the
 * select_state_machine_state it owes (after a state completes or after the
 * user answers a state's question) before the runner gives up and records an
 * `error` terminal. Bounds the protocol-violation retry loop so a parent that
 * never transitions can't spin forever.
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
  /** Virtual-model policy owner for the parent session; absent for concrete selections. */
  protected modelRouter?: ModelRouter;
  /** Advisor target and transcript budget selected with the current virtual tier. */
  private advisorPolicy?: AdvisorPolicy;
  /** Image capability fact carried from the active parent prompt into intra-turn prepares. */
  private parentPromptHasImages = false;
  /** True only while the parent pi agent is actively producing the public terminal event. */
  private parentAgentRunning = false;
  /** Last turn-runner control tool result observed from the parent agent. */
  private parentControlResult: TurnRunnerControlResult = { type: "none" };
  /** Runtime owner for state-machine progress and active state work. */
  private readonly stateMachineController: StateMachineController;
  /** Parent prompt started by a steer while state-machine work is driving the turn. */
  private activeStateWorkPrompt?: Promise<TurnTerminalEvent>;
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

  constructor(readonly config: TurnRunnerConfig) {
    this.skillContext = new SkillContext(config);
    this.stateMachineController = new StateMachineController({
      cwd: config.cwd ?? process.cwd(),
      createStateAgent: (input) => this.createStateAgentHandle(input),
      onSessionChanged: (session) => this.emit({ type: "state_machine", stateMachine: session }),
    });
  }

  async dispose(): Promise<void> {
    this.parentAgent?.clearAllQueues();
    this.activeStateWorkPrompt = undefined;
    this.setQueuedCommands([]);
    this.clearFollowUpQueue();
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
   * Rejected with a soft warning when a turn chain is in flight —
   * mutating the horizon mid-stream would invalidate the request the
   * parent (or a state agent) is already dispatching. `activeTurnPromise`
   * is the single source of truth here, so poll/timer sleeps pass the
   * gate cleanly: the chain has already resolved to the `sleep` terminal
   * before compact is allowed to run.
   */
  async compact(): Promise<void> {
    this.requireStarted();
    // `activeTurnPromise` is the single source of truth for "a turn chain
    // is in flight" — it covers the parent agent dispatching, a state
    // agent dispatching while the parent is paused, and a poll/script
    // command currently executing. Sleep terminals (poll/timer waits)
    // have already resolved the chain and cleared this, so compact is
    // free to run during those waits.
    if (this.activeTurnPromise || this.compactInFlight) {
      this.emit({
        type: "system",
        level: "warn",
        message: this.compactInFlight
          ? "compact ignored: a compact pass is already in progress."
          : "compact ignored: a turn chain is in flight; send compact between turns.",
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
    this.stateMachineController.hydrate(state.stateMachine);
    // Hydrate the wire-shaping object in place. `this.wireGuardHorizon` is
    // referenced by the observational context transform; replacing the
    // reference would orphan the transform's view. `Object.assign` over
    // the fresh default lets the persisted state contribute every field
    // it carries without this code knowing the field list.
    if (state.wireGuardHorizon) {
      Object.assign(this.wireGuardHorizon, state.wireGuardHorizon);
    }
    this.setState(state);
    this.initializeParentAgent();
    this.started = true;
    const hydratedState = this.requireRunnerState();
    this.emit({ type: "turn_started", state: hydratedState });
    return hydratedState;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.requireStarted();
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
      return this.activeTurnPromise;
    }

    const activeTurnPromise = this.runTurnChain(command);
    this.activeTurnPromise = activeTurnPromise;
    try {
      return await activeTurnPromise;
    } finally {
      if (this.activeTurnPromise === activeTurnPromise) {
        this.activeTurnPromise = undefined;
      }
    }
  }

  private async runTurnChain(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.turnUsage = undefined;
    this.turnUsageByModel = undefined;
    try {
      let terminal: TurnTerminalEvent;
      terminal = await this.executeTurnCommand(command);
      terminal = await this.drainQueuedTurnCommands(terminal);
      terminal = { ...terminal, state: this.snapshotState(terminal.state) };
      if (this.turnUsage) {
        terminal = {
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
      this.setState(terminal.state);
      this.emit(terminal);
      return terminal;
    } finally {
      this.turnUsage = undefined;
      this.turnUsageByModel = undefined;
    }
  }

  private async executeTurnCommand(command: TurnCommand): Promise<TurnTerminalEvent> {
    switch (command.type) {
      case "prompt":
        return this.prompt(command);
      case "answer":
        return this.answer(command);
      case "wake":
        return this.wake();
    }
  }

  private handleCommandDuringActiveTurn(command: TurnCommand): void {
    if ((command.type === "prompt" || command.type === "answer") && this.parentAgentRunning) {
      // The parent pi-agent is currently driving the public terminal event, so
      // user input can go straight to pi using pi's native steer/follow-up queues.
      this.sendCommandToAgent(this.requireParentAgent(), command);
      return;
    }

    if (command.type === "prompt" || command.type === "answer") {
      const message = this.commandToUserMessage(command);
      if (this.stateMachineController.hasActiveWork()) {
        if (command.behavior === "follow_up") {
          // State-machine work is driving the terminal event. Follow-ups are
          // transition context, so replay them before the next state decision.
          this.enqueueTurnCommand(command);
          return;
        }
        this.startParentPromptDuringActiveStateWork(message, command);
        return;
      }
    }

    this.enqueueTurnCommand(command);
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

  private startParentPromptDuringActiveStateWork(
    message: string,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): void {
    const prompt = this.runParentPromptDuringActiveStateWork(message, command);
    this.activeStateWorkPrompt = prompt;
    void prompt.finally(() => {
      if (this.activeStateWorkPrompt === prompt) this.activeStateWorkPrompt = undefined;
    });
  }

  private async runParentPromptDuringActiveStateWork(
    message: string,
    command: TurnPromptCommand | TurnAnswerCommand,
  ): Promise<TurnTerminalEvent> {
    const prompt =
      command.behavior === "steer"
        ? dedent`
            <system-reminder>
            The user sent this as a steer message while state-machine work is running.
            If the state-machine should change course, call select_state_machine_state to restart the current state with updated input or choose a different state.
            </system-reminder>

            ${message}
          `
        : message;
    const terminal = await this.prompt({
      type: "prompt",
      message: prompt,
      behavior: command.behavior,
      images: command.type === "prompt" ? command.images : undefined,
    });
    this.setState(terminal.state);
    return terminal;
  }

  private async drainQueuedTurnCommands(terminal: TurnTerminalEvent): Promise<TurnTerminalEvent> {
    let latest = terminal;
    while (this.getQueuedCommands().length > 0) {
      if (
        latest.type === "sleep" &&
        this.getQueuedCommands().every((command) => this.isFollowUpQueueCommand(command))
      ) {
        return latest;
      }
      if (
        latest.type === "interrupted" ||
        (latest.type === "complete" && latest.status === "failed")
      ) {
        this.setQueuedCommands([]);
        this.clearFollowUpQueue();
        return latest;
      }
      const queued = this.shiftQueuedCommand();
      if (!queued) break;
      this.removeQueuedFollowUpPrompt(queued);
      this.setState({
        ...latest.state,
        followUpQueue: this.getFollowUpQueue(),
        queuedCommands: this.getQueuedCommands(),
      });
      // A wake only has work to do when the runner is currently sleeping on
      // a scheduled state. If the session moved on (the prior queued
      // command already drove the state machine, or the session was never
      // sleeping to begin with), running wake here would emit a
      // "Nothing to wake." terminal that clobbers the real terminal from
      // the previous command in this drain chain. Skipping the queued wake
      // keeps the meaningful terminal as the single emitted event.
      if (queued.type === "wake" && latest.state.status !== "sleeping") {
        continue;
      }
      latest = await this.executeTurnCommand(queued);
    }
    return latest;
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

  private enqueueTurnCommand(command: TurnCommand): void {
    if (
      (command.type === "prompt" || command.type === "answer") &&
      command.behavior === "follow_up"
    ) {
      this.appendFollowUpPrompt(this.commandToUserMessage(command), command.images);
    }
    this.setQueuedCommands([...this.getQueuedCommands(), command]);
  }

  private replaceFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    this.setFollowUpQueue(entries);
    this.parentAgent?.clearFollowUpQueue();
    for (const entry of this.getFollowUpQueue()) {
      this.parentAgent?.followUp(buildUserAgentMessage(entry.message, entry.images));
    }
    this.replaceQueuedFollowUpCommands(entries);
    this.emitFollowUpQueue();
  }

  private replaceQueuedFollowUpCommands(entries: TurnFollowUpQueueEntry[]): void {
    this.removeQueuedFollowUpCommands();
    if (!this.state || this.parentAgentRunning) return;
    this.setQueuedCommands([
      ...this.getQueuedCommands(),
      ...entries.map(
        (entry) =>
          ({
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          }) satisfies TurnPromptCommand,
      ),
    ]);
  }

  private removeQueuedFollowUpCommands(): void {
    this.setQueuedCommands(
      this.getQueuedCommands().filter((command) => !this.isFollowUpQueueCommand(command)),
    );
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
    const hadActiveControllerWork = this.stateMachineController.hasActiveWork();
    this.stateMachineController.interrupt("Interrupted");
    const interruptedState = this.snapshotState(this.state);
    const terminal: TurnTerminalEvent = {
      type: "interrupted",
      state: {
        ...interruptedState,
        status: "interrupted",
        agent: { ...interruptedState.agent, status: "cancelled" },
      },
    };
    this.setState(terminal.state);
    if (this.parentAgentRunning || hadActiveControllerWork) {
      // The active turn emits the terminal event after agent.prompt() unwinds;
      // interrupt() only aborts out-of-band. The interrupted snapshot is
      // already on `this.state` above — `runAgentWorker` reads it from there.
      this.parentAgentInterrupted = true;
    }
    this.parentAgent?.abort();
    this.parentAgent?.clearAllQueues();
    this.activeStateWorkPrompt = undefined;
    this.setQueuedCommands([]);
    this.clearFollowUpQueue();
    this.parentAgentRunning = false;
  }

  protected emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  protected async prompt(command: TurnPromptCommand): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state = this.clearFinishedTodosAtTurnStart({ ...originalState, status: "running" });
    const resolvedPrompt = this.skillContext.resolveSlashSkillPrompt(command.message);
    const todoReminder = formatCarriedTodosReminder(state.todos);
    const prompt = todoReminder ? `${todoReminder}\n\n${resolvedPrompt}` : resolvedPrompt;
    const images = promptImagesToContent(command.images);
    let terminal: TurnTerminalEvent;
    if (state.mode === "agent") {
      terminal = await this.runAgentMode(state, prompt, images);
    } else {
      terminal = await this.runTurnRunnerAgentWithStateMachineTools({
        state,
        prompt,
        images,
        mode: state.mode,
      });
    }

    return this.restoreSleepAfterPromptIfNeeded(originalState, terminal);
  }

  protected async answer(command: TurnAnswerCommand): Promise<TurnTerminalEvent> {
    const message = this.commandToUserMessage(command);
    return this.prompt({
      type: "prompt",
      message,
      behavior: command.behavior,
      images: command.images,
    });
  }

  protected async wake(): Promise<TurnTerminalEvent> {
    const originalState = this.requireRunnerState();
    const state: TurnState = { ...originalState, status: "running" };

    if (originalState.status === "sleeping") {
      // Sleeping scheduled states already ended the previous duet-agent turn.
      // Wake starts a new state-machine-driven turn; normal prompts while
      // sleeping instead start parent-driven turns.
      const result = await this.stateMachineController.wake();
      if (result) return this.driveStateMachineResult(result, state);
    }

    return {
      type: "complete",
      status: "completed",
      state: originalState,
      result: "Nothing to wake.",
    };
  }

  private restoreSleepAfterPromptIfNeeded(
    originalState: TurnState,
    terminal: TurnTerminalEvent,
  ): TurnTerminalEvent {
    if (
      originalState.status !== "sleeping" ||
      terminal.type !== "complete" ||
      !isWaitingOnScheduledState(terminal.state.stateMachine)
    ) {
      return terminal;
    }

    if (terminal.status === "failed") {
      this.emit({
        type: "system",
        level: "error",
        message: terminal.error ?? terminal.result ?? "Prompt failed while waiting.",
      });
    }

    const state = currentScheduledState(terminal.state.stateMachine);
    const progress = state ? terminal.state.stateMachine?.progress?.states[state.name] : undefined;
    const wakeAt = progress?.nextWakeAt ?? scheduledStateFallbackWakeAt(state);
    return {
      type: "sleep",
      wakeAt,
      state: { ...terminal.state, status: "sleeping" },
    };
  }

  private controllerResultToTerminal(
    result: StateMachineExecutionResult,
    baseState = this.requireRunnerState(),
  ): TurnTerminalEvent {
    const state = this.snapshotState(baseState);
    switch (result.type) {
      case "state_completed":
        return completeTurn(state, "completed", JSON.stringify(result.output ?? null));
      case "ask":
        return {
          type: "ask",
          questions: result.questions,
          state: { ...state, status: "waiting_for_human" },
        };
      case "sleep":
        return { type: "sleep", wakeAt: result.wakeAt, state: { ...state, status: "sleeping" } };
      case "interrupted":
        return { type: "interrupted", state: { ...state, status: "interrupted" } };
      case "terminal":
        if (result.status === "error") {
          // A runtime failure (poll timeout, unknown/invalid selected state,
          // agent/script state failure, misconfigured-poll gate, or exhausted
          // protocol-violation retries) is the ONLY state-machine outcome that
          // fails the turn. The user-facing message rides on event.error; the
          // same string is also recorded on state.stateMachine.terminal.reason
          // by recordStateFailed, so the parent's acknowledgment turn and the
          // board/relay see the identical reason.
          return completeTurn(state, "failed", undefined, result.error);
        }
        // A deliberately selected terminal (completed/failed/cancelled, incl.
        // the auto-injected `cancelled` that `wont do` maps to) is a
        // successful turn outcome — not a user abort. Report turn-completion
        // status "completed" so the backend never surfaces "Error: cancelled —
        // try again". The machine's own status survives on
        // state.stateMachine.terminal.status (set by recordStateMachineCompleted),
        // which is what the board column resolves from. Only an explicit user
        // stop — type:"interrupted" via interrupt() — surfaces the cancel
        // message.
        return completeTurn(state, "completed", result.result);
    }
  }

  private async driveStateMachineResult(
    result: StateMachineExecutionResult,
    baseState = this.requireRunnerState(),
  ): Promise<TurnTerminalEvent> {
    let next = result;
    let state = baseState;
    // The controller only executes states. TurnRunner owns the continuation
    // loop so queued follow-ups always update the parent transcript before the
    // parent chooses the next state.
    while (next.type === "state_completed") {
      state = this.requireRunnerState();
      const queued = await this.drainQueuedTurnCommands({
        type: "complete",
        status: "completed",
        state: this.snapshotState({ ...state, status: "running" }),
      });
      if (queued.type !== "complete" || queued.status !== "completed") return queued;
      this.setState(queued.state);
      state = queued.state;
      next = await this.selectNextStateAfterCompletion(next.stateName, next.output);
    }
    if (next.type === "interrupted" && this.activeStateWorkPrompt) {
      return this.activeStateWorkPrompt;
    }
    if (next.type === "terminal") {
      // Run the parent's terminal acknowledgment turn so the
      // state-machine outcome is propagated back to the parent.
      // `terminate: true` on the state-machine tools means the parent's
      // prompt loop ends right after it selects a terminal (or a state
      // that then errors at runtime) — without this pass the parent has
      // no transcript entry for the outcome and cannot summarize it to
      // the user before control returns to them.
      const acknowledged = await this.runStateMachineTerminalAcknowledgment();
      if (acknowledged) return acknowledged;
      state = this.requireRunnerState();
    }
    return this.controllerResultToTerminal(next, state);
  }

  /**
   * Re-prompt the parent agent once after a state-machine terminal.
   *
   * The flag is per-session, so a fresh state machine created during
   * the acknowledgment turn — which `createStateMachineSession` builds
   * as a brand-new session object — will run its own acknowledgment
   * when it terminates. The flag's only job is to prevent the same
   * session.terminal from being re-acknowledged, which would otherwise
   * happen if the parent (incorrectly) routes back into the controller
   * on the already-terminal session and the controller re-records a
   * terminal on it.
   *
   * Behavior:
   * - Builds the acknowledgment prompt via
   *   `formatStateMachineTerminalAcknowledgmentPrompt`. The prompt is
   *   neutral with respect to "decided vs runtime failure" — the
   *   parent's own transcript already shows whether it selected the
   *   terminal, and `status`/`reason` carry the rest of the framing.
   * - Runs one parent worker pass with full state-machine tool access.
   *   The parent is steered to reply in plain text and let control
   *   return to the user; full tool access only means a control action
   *   on this turn (e.g. an explicitly instructed create) is handled
   *   rather than silently dropped, per the next bullet.
   * - On interruption, surfaces an `interrupted` terminal event for
   *   the whole turn.
   * - When the parent's reply carries a control action, drives that
   *   control through the standard `driveStateMachineResult` path so
   *   any newly-created state machine runs end-to-end and itself
   *   produces a follow-up terminal (which also gets acknowledged via
   *   its own session).
   * - When the parent's reply is plain text, returns `undefined` so
   *   the caller renders the original terminal (preserving
   *   status/error/SM history) and the parent's natural-language
   *   summary lands on the transcript as the final assistant message.
   */
  private async runStateMachineTerminalAcknowledgment(): Promise<TurnTerminalEvent | undefined> {
    const session = this.stateMachineController.getSession();
    if (!session?.terminal || session.terminalAcknowledged) return undefined;
    this.stateMachineController.markTerminalAcknowledged();
    const sessionForPrompt = this.stateMachineController.getSession();
    if (!sessionForPrompt?.terminal) return undefined;
    const acknowledgmentPrompt = formatStateMachineTerminalAcknowledgmentPrompt({
      session: sessionForPrompt,
    });
    // `snapshotState` re-reads parentAgent messages directly, so this turn
    // state includes the parent's transcript through the terminal-selecting
    // tool call without a separate refresh step.
    const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
    const workerResult = await this.runAgentWorker({
      state: turnState,
      prompt: acknowledgmentPrompt,
      ...this.createTools(turnState.mode),
    });
    this.setState(workerResult.outcome.state);
    if (workerResult.outcome.type === "interrupted") {
      return { type: "interrupted", state: workerResult.outcome.state };
    }
    const followUp = await this.controllerResultFromWorkerResult(
      workerResult,
      workerResult.outcome.state,
    );
    // On the acknowledgment turn the prior machine is already terminal, so a
    // create_state_machine_definition here is legal follow-up work, not a
    // violation — controllerResultFromWorkerResult returns it as a result.
    // A plain-text reply returns undefined so the caller renders the original
    // terminal with the parent's summary as the final assistant message.
    if (followUp) {
      return this.driveStateMachineResult(followUp, workerResult.outcome.state);
    }
    return undefined;
  }

  /**
   * Build a loop-warning system reminder when the orchestrator has selected the
   * same state many times in a row within a short window with no other state
   * running in between. This is the idle-"holding" hot loop: re-selecting a
   * state to "keep waiting" is a no-op because selecting runs the state again
   * immediately rather than suspending. The reminder re-teaches the only
   * primitives that actually wait — ask_user_question for a human reply, a poll
   * for a checkable condition, a timer for a fixed time — and tells the parent
   * to stop re-selecting the same state unchanged. Returns undefined when the
   * streak is below threshold or spread over too long a span to be a hot loop.
   */
  private repeatedSelectionLoopWarning(stateName: string): string | undefined {
    const session = this.stateMachineController.getSession();
    const count = session ? repeatedSelectionLoopCount(session, stateName) : undefined;
    if (count === undefined) return undefined;
    return dedent`
      <system-reminder>
      LOOP DETECTED: you have selected the "${stateName}" state ${count} times in a row, with no other state running in between, in quick succession. Selecting a state is NOT how you wait — every select_state_machine_state call runs the state again immediately and returns, so re-selecting the same "holding" state over and over is a no-op hot loop that suspends nothing.

      If you are waiting on something, back it with the primitive that actually suspends, chosen by WHAT you are waiting for:
      - a human reply or approval → an agent state that calls ask_user_question, then END YOUR TURN. The user's answer arrives as a fresh turn, and only then do you select the next state. Do not re-select to "keep waiting", and if the user sends an unrelated message while the question is open, answer it in plain text and end the turn rather than re-parking this state.
      - a condition a command can check (CI finished, a file appeared, a deploy went ready) → a poll state whose command exits success only when the condition is actually met.
      - a fixed future time → a timer state (wakeAt or wakeAfterMs).

      If you are not waiting but re-running "${stateName}" to fix a failure, change override.prompt to address the specific failure before selecting again — selecting it unchanged reproduces the same result. If there is nothing left to do here, advance to the next real state or a terminal. Do NOT select "${stateName}" again unchanged.
      </system-reminder>
    `;
  }

  private async selectNextStateAfterCompletion(
    stateName: string,
    output?: unknown,
  ): Promise<StateMachineExecutionResult> {
    const loopWarning = this.repeatedSelectionLoopWarning(stateName);
    return this.enforceParentTransition(
      (retryInstruction) => dedent`
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
      `,
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  /**
   * Enforce the transition owed after an agent state asked the user a question
   * and the user answered without the parent advancing the machine.
   *
   * The user's answer already ran as an ordinary parent prompt; reaching here
   * means that turn emitted no `select_state_machine_state`, so the machine is
   * still suspended at the asking state. Re-prompt under the same bounded
   * budget as a completed state, then record an `error` terminal if the parent
   * still refuses to advance.
   */
  private async enforceTransitionAfterAnsweredAsk(): Promise<StateMachineExecutionResult> {
    const stateName = this.stateMachineController.getSession()?.currentState ?? "";
    return this.enforceParentTransition(
      (retryInstruction) => dedent`
        You received the user's answer to the question asked by the "${stateName}" state, but you did not call select_state_machine_state. The machine is still suspended at that state and will not advance on its own.

        <system-reminder>
        THIS TURN MUST END WITH A select_state_machine_state TOOL CALL. The user's answer is the input you route on: pick the next state (or a terminal, including a cancelled terminal if the answer means the work should stop) and pass the answer forward via input or override.prompt. Narration without the tool call ("the user chose X, so I'll move to Y") does not advance the machine and will be rejected and re-prompted.

        ${retryInstruction ?? ""}
        </system-reminder>
      `,
      "User answered the question, but the runner did not call select_state_machine_state.",
    );
  }

  /**
   * Shared bounded-retry loop for transitions the parent owes the machine.
   * Re-prompts up to `PARENT_TRANSITION_RETRY_BUDGET` times with `buildPrompt`
   * (the second and later attempts carry a retry reminder); the first attempt
   * that emits a control action returns its result. When the budget is
   * exhausted with no control action, records an `error` terminal carrying
   * `failureReason` — a runtime failure of the machine, not a deliberate
   * `failed` selection.
   */
  private async enforceParentTransition(
    buildPrompt: (retryInstruction: string | undefined) => string,
    failureReason: string,
  ): Promise<StateMachineExecutionResult> {
    for (let attempt = 1; attempt <= PARENT_TRANSITION_RETRY_BUDGET; attempt++) {
      const retryInstruction =
        attempt === 1
          ? undefined
          : `This is retry ${attempt} of ${PARENT_TRANSITION_RETRY_BUDGET}. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;
      const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
      const workerResult = await this.runAgentWorker({
        state: turnState,
        prompt: buildPrompt(retryInstruction),
        ...this.createTools(turnState.mode),
      });
      this.setState(workerResult.outcome.state);
      const result = await this.controllerResultFromWorkerResult(
        workerResult,
        workerResult.outcome.state,
      );
      if (result) return result;
    }

    return this.stateMachineController.failActiveSession(
      this.stateMachineController.getSession()?.currentState ?? "",
      failureReason,
    );
  }

  protected createStateAgentHandle(input: {
    state: StateMachineAgentState;
    prompt: string;
  }): StateAgentHandle {
    let control: TurnRunnerControlResult = { type: "none" };
    const seedMessages = this.resolveStateAgentSeedMessages(input.state);
    // Capture the seeded prefix length up front. The sub-agent's result,
    // partial text, and recorded usage are all computed by slicing this prefix
    // off agent.state.messages so a forked parent transcript isn't folded into
    // this run. Reading `seedMessages.length` lazily at each call site would be
    // wrong if the agent ever appended into the seed array in place, so snapshot
    // the count once.
    const seedMessageCount = seedMessages.length;
    const state: TurnState = {
      status: "running",
      mode: "agent",
      // Layer the agent state's optional per-state model/thinkingLevel over the
      // inherited parent options; see StateMachineAgentState for why these are
      // UI-set rather than model-chosen.
      options: {
        ...this.requireRunnerState().options,
        ...(input.state.model ? { model: input.state.model } : {}),
        ...(input.state.thinkingLevel ? { thinkingLevel: input.state.thinkingLevel } : {}),
      },
      agent: {
        status: "running",
        messages: seedMessages,
      },
    };
    const stateSkills = this.skillContext.resolveStateAgentSkills(input.state);
    // Expand `/skill` slash commands the same way the parent prompt path does,
    // scoped to the skills this state is actually allowed to use. Lets state
    // prompts say "use the /foo skill to do xyz" and have the skill body
    // injected, instead of shipping the literal `/foo` text to the model.
    const expandedPrompt = this.skillContext.resolveSlashSkillPrompt(input.prompt, stateSkills);
    // Hand the sub-agent the machine's overall goal, the full state list, and
    // which state it is running so it scopes its work to this state instead of
    // running the whole process (a common over-reach on smaller models). The
    // session always exists while an agent state is executing.
    const session = this.stateMachineController.getSession();
    const machineContext = session
      ? { definition: session.definition, currentState: input.state.name }
      : undefined;
    const forkContext = input.state.forkContext === true;
    const identityLayer = createStateAgentSystemPromptLayer(machineContext);
    // When forking, the sub-agent's identity + per-state systemPrompt layers
    // ride in the tail user turn so the system prompt can stay byte-identical to
    // the parent's and preserve the provider prompt-cache prefix. There is one
    // exception: a state that restricts skills via allowedSkills must NOT inherit
    // the parent's full skill catalog. resolveStateAgentSkills returns undefined
    // only for an unrestricted state; when it returns a concrete allowlist we
    // rebuild the system prompt around that allowlist instead of reusing the
    // parent's verbatim, trading the cache prefix for the allowlist contract.
    const forkSystemPrompt = forkContext
      ? stateSkills === undefined
        ? this.parentAgent?.state.systemPrompt
        : this.createBaseSystemPromptWithAppendedLayers({ skills: stateSkills })
      : undefined;
    const tailPrompt = forkContext
      ? [createForkContextReminder(), identityLayer, input.state.systemPrompt, expandedPrompt]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : expandedPrompt;
    const agent = this.createAgent(
      {
        state,
        ...(forkSystemPrompt ? { systemPrompt: forkSystemPrompt } : {}),
        prependSystemPrompt: forkContext ? undefined : identityLayer,
        appendSystemPrompt: forkContext ? undefined : input.state.systemPrompt,
        skills: stateSkills,
        // Per-state cwd lets one agent state operate on a different
        // repository or subdirectory than the parent runner without
        // mutating shared config.
        ...this.createTools("agent", input.state.cwd, false),
      },
      (result) => {
        control = result;
      },
    );
    let unsubscribe: (() => void) | undefined;
    let interruptedReason: string | undefined;
    const finish = (): StateAgentResult => {
      if (control.type === "ask_user_question") {
        return { type: "ask", questions: control.questions };
      }
      if (agent.state.errorMessage) {
        return { type: "failed", error: agent.state.errorMessage };
      }
      return {
        type: "complete",
        result: assistantText(agent.state.messages.slice(seedMessageCount)),
      };
    };

    const origin: TurnEventOrigin = {
      kind: "state_machine_agent",
      state: input.state.name,
    };
    // A state agent runs a turn just like the parent — a loop of completion
    // calls — so it streams a `usage` event per completion from its own
    // `message_end` events. The finally block falls back to summing the whole
    // message list only when no `message_end` fired (stubbed-agent test path).
    let recordedMessageUsage = false;
    return {
      prompt: async () => {
        unsubscribe = agent.subscribe((event) => {
          this.emitAgentEvent(event, origin);
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          // Record always; tick only on a completion that consumed tokens (see
          // the parent path for why a zero-usage attempt must not emit).
          this.recordUsage(event.message.usage, event.message.model);
          recordedMessageUsage = true;
          if (event.message.usage.totalTokens > 0) this.emitTurnUsage(origin);
        });
        try {
          await agent.prompt(tailPrompt);
          await this.retryTransientServerErrors(agent);
          return interruptedReason ? { type: "interrupted" } : finish();
        } catch (error) {
          if (interruptedReason) return { type: "interrupted" };
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
          // Fallback for the stubbed-agent path: when no `message_end` streamed,
          // fold the message list's usage in on every exit path — success,
          // error, or interrupt — so partial work still reaches the aggregate.
          // Slice off the seeded prefix so a forked parent transcript's usage
          // isn't double-counted (parent messages may already carry usage from
          // the parent turn).
          if (!recordedMessageUsage) {
            this.recordUsage(
              usageFromMessages(agent.state.messages.slice(seedMessageCount)),
              agent.state.model.id,
            );
            this.emitTurnUsage(origin);
          }
          unsubscribe?.();
        }
      },
      interrupt: (reason) => {
        interruptedReason = reason;
        agent.abort();
        agent.clearAllQueues();
        unsubscribe?.();
      },
      partialAssistantText: () =>
        assistantText(agent.state.messages.slice(seedMessageCount)) || undefined,
      interruptedReason: () => interruptedReason,
    };
  }

  private requireRunnerState(): TurnState {
    if (!this.state) {
      throw new Error("Turn runner has not been started.");
    }
    return this.state;
  }

  private resolveStateAgentSeedMessages(state: StateMachineAgentState): AgentMessage[] {
    if (!state.forkContext) return [];
    return [...(this.parentAgent?.state.messages ?? [])];
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
      stateMachine: this.stateMachineController.getSession(),
      todos: copyOptionalArray(state.todos ?? this.state?.todos),
      followUpQueue: copyOptionalArray(state.followUpQueue ?? this.state?.followUpQueue),
      queuedCommands: copyOptionalArray(state.queuedCommands ?? this.state?.queuedCommands),
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

  private getQueuedCommands(): TurnCommand[] {
    return [...(this.state?.queuedCommands ?? [])];
  }

  private setQueuedCommands(commands: TurnCommand[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, queuedCommands: [...commands] });
  }

  private shiftQueuedCommand(): TurnCommand | undefined {
    const commands = this.getQueuedCommands();
    const [command, ...remaining] = commands;
    this.setQueuedCommands(remaining);
    return command;
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
      // Source-of-truth-first guidance always applies: even without
      // configured memory, the agent should still prefer live tools,
      // skills, and files in cwd over guessed answers.
      createSourceOfTruthSystemPromptLayer(),
    ].filter((layer): layer is string => Boolean(layer));
    const appendSystemPrompt = layers.length > 0 ? layers.join("\n\n") : undefined;
    this.parentControlResult = { type: "none" };
    this.parentAgent = this.createAgent(
      {
        state,
        appendSystemPrompt,
        ...(this.modelRouter ? { router: this.modelRouter } : {}),
        ...this.createTools(state.mode),
      },
      (result) => {
        this.parentControlResult = result;
      },
    );
    this.replayFollowUpQueueIntoAgent(this.parentAgent);
    this.snapshotActiveAgentState();
  }

  protected async runTurnRunnerAgentWithStateMachineTools(input: {
    state: TurnState;
    prompt: string;
    images?: ImageContent[];
    mode: Exclude<TurnMode, "agent">;
  }): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorker({
      state: input.state,
      prompt: input.prompt,
      images: input.images,
    });

    const result = await this.controllerResultFromWorkerResult(workerResult, input.state);
    if (result) return this.driveStateMachineResult(result, workerResult.outcome.state);
    // The parent emitted no control action. If the machine is suspended at a
    // state that asked the user a question, the parent owed a transition to
    // advance it (the user's answer arrives as an ordinary parent prompt).
    // Enforce it the same way a completed state does, so an answered ask can
    // never silently stall the machine.
    if (isAwaitingUserAnswer(this.stateMachineController.getSession())) {
      const enforced = await this.enforceTransitionAfterAnsweredAsk();
      return this.driveStateMachineResult(enforced, this.requireRunnerState());
    }
    return this.outcomeToTerminal(workerResult.outcome);
  }

  /**
   * Turns a parent worker turn's control output into the state-machine
   * execution result the turn runner should drive next, or `undefined` when
   * the parent emitted no control tool call. Whether that `undefined` is
   * benign (a top-level agent turn just answering) or a violation (it owed a
   * select_state_machine_state) is the caller's decision. A valid control
   * action — select a state, ask the user, or create a machine (including a
   * replaceActive reset of an active machine) — returns its result.
   */
  private async controllerResultFromWorkerResult(
    workerResult: AgentWorkerResult,
    state: TurnState,
  ): Promise<StateMachineExecutionResult | undefined> {
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
      const active = this.stateMachineController.getSession();
      if (active && !active.terminal) {
        this.stateMachineController.supersedeActiveSession(
          `Superseded by a new state machine ("${control.definition.name}").`,
        );
      }

      const firstState = control.firstState;
      this.stateMachineController.startSession({
        prompt: workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
        definition: control.definition,
        currentState: firstState,
      });
      return this.stateMachineController.runDecision({ state: firstState });
    }

    if (!this.stateMachineController.getSession() && typeof state.mode === "object") {
      this.stateMachineController.startSession({
        prompt: workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
        definition: state.mode as Exclude<TurnMode, "agent" | "auto">,
        currentState: control.decision.state,
      });
    }
    return this.stateMachineController.runDecision(control.decision);
  }

  protected createTools(
    mode: TurnMode,
    cwdOverride?: string,
    includeAdvisor = true,
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
      sessionId: this.config.sessionId,
      // Reuse the resolved memory model so recall_memory's optional
      // expand flag goes to the same cheap model the observer uses.
      expansionModel: this.resolveMemoryActorModel(undefined),
    };
    const router = this.modelRouter;
    const advisorStorage =
      includeAdvisor && router && this.advisorPolicy?.enabled
        ? this.createAskAdvisorStorage(router, this.advisorPolicy)
        : undefined;
    if (mode === "agent") {
      return {
        tools: [
          ...createDefaultTurnRunnerTools(cwd, todoStorage, recallStorage, advisorStorage),
          ...mcpTools,
        ],
      };
    }

    return {
      tools: [
        ...createTurnRunnerTools({
          cwd,
          mode,
          getDefinition: () => this.stateMachineController.getSession()?.definition,
          getStateMachine: () => this.stateMachineController.getSession(),
          getActiveStateOutput: () => this.stateMachineController.getActiveOutput(),
          todoStorage,
          skills,
          recallStorage,
          advisorStorage,
        }),
        ...mcpTools,
      ],
    };
  }

  private createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const modelName = resolveModelName(policy.target.modelName).id;
    return {
      getMessages: () => this.parentAgent?.state.messages ?? this.state?.agent.messages ?? [],
      getSystemPrompt: () => this.parentAgent?.state.systemPrompt ?? "",
      getObservations: async () => {
        const session = this.memoryPersistence?.session;
        const sessionId = this.config.sessionId;
        if (!session || !sessionId) return [];
        const snapshot = await readSessionObservations(session, sessionId);
        return snapshot.observations.map((observation) => observation.content);
      },
      budgetTokens: policy.transcriptTokens,
      modelName,
      thinkingLevel: policy.target.thinkingLevel,
      advisorGate: () => router.advisorGate(),
      noteAdvisorConsult: () => router.noteAdvisorConsult(),
    };
  }

  private replayFollowUpQueueIntoAgent(agent: Agent): void {
    for (const entry of this.getFollowUpQueue()) {
      agent.followUp(buildUserAgentMessage(entry.message, entry.images));
    }
  }

  protected async runAgentMode(
    state: TurnState,
    prompt: string,
    images?: ImageContent[],
  ): Promise<TurnTerminalEvent> {
    const workerResult = await this.runAgentWorker({
      state,
      prompt,
      images,
    });
    if (workerResult.control.type === "ask_user_question") {
      return this.askUserQuestion(workerResult.outcome.state, workerResult.control);
    }
    return this.outcomeToTerminal(workerResult.outcome);
  }

  protected async runAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    if (this.parentAgentRunning) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }

    const agent = this.requireParentAgent();
    this.parentControlResult = { type: "none" };
    this.setParentAgentRunning(true);

    const unsubscribe = agent.subscribe((event) => this.emitParentAgentEvent(event));
    this.parentAgentInterrupted = false;
    try {
      this.parentPromptHasImages = (input.images?.length ?? 0) > 0;
      const switched = await this.modelRouter?.prepareTurn({
        hasImages: this.parentPromptHasImages,
        prevTurnHint: input.prompt,
        signal: agent.signal,
      });
      if (switched) this.applyRouterSwitch(agent, switched);
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
        control: this.parentControlResult,
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
      queuedCommands: live?.queuedCommands ?? input.state.queuedCommands,
    } satisfies TurnState;
    if (status === "completed") {
      await this.updateMemoryAfterAgentRun(messages, state.options);
    }

    return {
      control: this.parentControlResult,
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
      sessionId: this.config.sessionId,
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
    if (result.reflections.length > 0) {
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
    // per-prompt command options. Keeping model and prompt shape stable protects
    // prompt caching across all pi-agent turns inside a duet-agent session.
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
      transformContext: this.createMemoryTransform(),
      ...(input.router
        ? {
            prepareNextTurn: async (signal?: AbortSignal) => {
              const switched = await input.router?.prepareTurn({
                hasImages: this.parentPromptHasImages,
                signal,
              });
              return switched ? this.applyRouterSwitch(agent, switched) : undefined;
            },
          }
        : {}),
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

  protected createMemoryTransform() {
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
      horizon: this.wireGuardHorizon,
      onCompaction: (messages) => this.ensureMemoryCoverageForCompaction(messages),
    });
  }

  // Sticky across all turns within this runner instance. Resets on
  // session resume (new runner). Mutated in place by the memory transform
  // when either the token or byte budget triggers eviction, and by
  // `runAgentWorker` on a provider context-overflow error so the retry
  // sends the newer half of history.
  protected readonly wireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkills();
  }

  /**
   * Re-discover installed skills from disk. Surfaces newly added skills
   * (e.g. installed in this session) without restarting the runner.
   * Callers typically pair this with `getSkills()` to refresh their
   * autocomplete catalog.
   */
  async reloadSkills(): Promise<readonly Skill[]> {
    await this.skillContext.reload();
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
    // Initial context pack build runs synchronously inside
    // loadStoredMemory so the very first dispatched turn already sees
    // a frozen memory prefix. Subsequent compaction triggers (reflector
    // completion, wire-shaping eviction) refresh it.
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
  }

  protected createBaseSystemPromptWithAppendedLayers(input?: {
    prepend?: Array<string | undefined>;
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return this.skillContext.createSystemPromptWithAppendedLayers(input);
  }

  private askUserQuestion(
    state: TurnState,
    control: Extract<TurnRunnerControlResult, { type: "ask_user_question" }>,
  ): TurnTerminalEvent {
    return {
      type: "ask",
      questions: control.questions,
      state: { ...state, status: "waiting_for_human" },
    };
  }

  /**
   * Lifts the internal `AgentWorkerOutcome` shape into the public
   * `TurnTerminalEvent` shape returned by `runTurnChain`. `runTurnChain`
   * attaches `usage` / `effectiveContextWindow` / `contextWindowUsage`
   * at the chain boundary, so this conversion intentionally omits them.
   */
  private outcomeToTerminal(outcome: AgentWorkerOutcome): TurnTerminalEvent {
    if (outcome.type === "interrupted") {
      return { type: "interrupted", state: outcome.state };
    }
    return {
      type: "complete",
      status: outcome.status,
      state: outcome.state,
      result: outcome.result,
      error: outcome.error,
    };
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
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    this.modelRouter?.noteAssistantStep(routerStepDelta(event.message));

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
    const turnUsage: TurnTokenUsage = this.turnUsage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
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
   * without jittering the parent context fields. No-ops when no usage has
   * been recorded yet or before the first parent emission — both are only
   * possible during construction/teardown or in test harnesses; a real
   * parent worker always sets the snapshot before its terminal usage is
   * recorded.
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
      globalMemory: pack.global.reduce((total, row) => total + estimateTokens(row.content), 0),
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

  /** Build the parent router only when the persisted session selection is virtual. */
  private async initializeModelRouter(modelName: string | undefined): Promise<void> {
    this.modelRouter = undefined;
    this.advisorPolicy = undefined;
    if (!modelName || isKnownShorthand(modelName)) return;
    try {
      resolveModelName(modelName);
      return;
    } catch {
      // A name outside the concrete catalog may be owned by the project routing table.
    }

    const catalogAdapter = {
      isCatalogName: isKnownShorthand,
      modelAcceptsImages: (name: string) => resolveModelName(name).input.includes("image"),
    };
    const loaded = await loadRoutingTable({
      cwd: this.config.cwd ?? process.cwd(),
      catalogAdapter,
    });
    if (!isVirtualModel(modelName, loaded.table)) return;
    this.advisorPolicy = loaded.table.tiers[modelName]!.advisor;
    this.modelRouter = this.createModelRouter({
      table: loaded.table,
      tier: modelName,
      classify: async (input, signal) => {
        const classifierModel = resolveModelName(loaded.table.classifier.target.modelName);
        return classifyRoute(input, {
          model: `${classifierModel.provider}:${classifierModel.id}`,
          signal,
        });
      },
      resolveCatalog: catalogAdapter,
    });
  }

  /** Composition seam used by production binding and deterministic runner tests. */
  protected createModelRouter(options: ModelRouterOptions): ModelRouter {
    return new ModelRouter(options);
  }

  /** Resolve and atomically apply one router-owned model/effort change. */
  private applyRouterSwitch(agent: Agent, switched: RouterSwitch) {
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

function routerStepDelta(
  message: Extract<AgentMessage, { role: "assistant" }>,
): string | undefined {
  const text = message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  const tools = message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => block.name);
  const parts = [
    text ? text.slice(-500) : undefined,
    tools.length > 0 ? `Tools: ${tools.join(", ")}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : undefined;
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
