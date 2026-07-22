import type { ScopeId, TaskId } from "../tasks/types.js";
import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { assistantText } from "../core/serializer.js";
import {
  classifyRoute,
  type ClassifierDecision,
  type ClassifyRouteOptions,
} from "../model-routing/classifier.js";
import {
  resolveRoute,
  type RouteResolutionCatalog,
  type ResolvedTarget,
} from "../model-routing/resolve.js";
import type { RoutingTable } from "../model-routing/table.js";
import type { TurnEventOrigin, TurnOptions, TurnState, TurnTokenUsage } from "../types/protocol.js";
import type { StateMachineDefinition } from "../types/state-machine.js";
import type { TransportName } from "../model-resolution/catalog.js";
import { createForkContextReminder, createStateAgentSystemPromptLayer } from "./prompts.js";
import { isExternallyVisibleAgentEvent } from "./agent-events.js";
import { isPostOutputConnectedFailure } from "../connected-providers/fallback.js";
import type { TurnRunnerControlResult } from "./tools.js";
import { usageFromMessages } from "./usage-accounting.js";

/** Complete internal description accepted by the shared sub-agent executor. */
export interface SubagentSpec {
  /** User prompt that defines the child agent's complete task. */
  prompt: string;
  /** Optional role or behavior layer applied only to this child. */
  systemPrompt?: string;
  /** Skill names the child may use; omission inherits the available skill set. */
  allowedSkills?: string[];
  /** Working directory for the child's coding tools. */
  cwd?: string;
  /** Exact or virtual model setting for this child. */
  model?: string;
  /** Reasoning effort applied to the child model. */
  thinkingLevel?: ThinkingLevel;
  /** Whether to seed the child with the parent's current transcript. */
  forkContext?: boolean;
}

/** Terminal outcome consumed by the sub-agent's owner after one prompt run. */
export type SubagentResult =
  | { type: "complete"; result?: string }
  | { type: "failed"; error: string }
  | { type: "interrupted" };

/** One in-flight execution created from a {@link SubagentSpec}. */
export interface SubagentRun {
  /** Starts the sub-agent using the executor-owned prompt and transcript. */
  prompt(): Promise<SubagentResult>;
  /** Aborts the sub-agent and makes its prompt settle as interrupted. */
  interrupt(reason: string): void;
  /** Text-only partial output, excluding any forked seed transcript. */
  partialAssistantText(): string | undefined;
  /** The reason passed to interrupt, or undefined while uninterrupted. */
  interruptedReason(): string | undefined;
}

export interface SubagentAgentConfigInput {
  /** Transient child turn state containing resolved options and seed messages. */
  state: TurnState;
  /** Identity layer placed before host system instructions for a fresh child. */
  prependSystemPrompt?: string;
  /** Per-child role layer placed after host system instructions. */
  appendSystemPrompt?: string;
  /** Fully rendered system prompt reused verbatim by an unrestricted context fork. */
  systemPrompt?: string;
  /** Skills rendered into the child system prompt; undefined means unrestricted. */
  skills?: Skill[];
  /** Runtime tools bound to this child's working directory and permissions. */
  tools: AgentTool[];
  /** Child-only memory identity and wire horizon; omission selects the parent runtime. */
  memoryContext?: SubagentMemoryContext;
}

/** Child-local memory identity and mutable wire-shaping state. */
export interface SubagentMemoryContext {
  /** Durable scratch namespace derived from the parent session and task id. */
  sessionId?: string;
  /** Horizon mutated only by this child's context transform. */
  horizon: import("../types/protocol.js").WireGuardHorizon;
}

interface SubagentMachineContext {
  definition: StateMachineDefinition;
  currentState: string;
}

export interface SubagentExecutionContext {
  /** Origin attached to every streamed child event and usage tick. */
  origin: TurnEventOrigin;
  /** Active relay definition used to keep a state worker inside its assigned state. */
  machineContext?: SubagentMachineContext;
  /** Scope owned by a spawned child; its nested tasks are cascade-stopped on close. */
  childScopeId?: `task:${TaskId}`;
  /** Scope that owns the spawn task and is the parent of childScopeId. */
  ownerScopeId?: ScopeId;
  /** Isolated observational-memory identity and horizon for this child. */
  memoryContext?: SubagentMemoryContext;
  /** Transcript source of the agent that called spawn_agent. */
  forkSource?: {
    messages(): AgentMessage[];
    systemPrompt(): string | undefined;
  };
  /** Runtime agent published after construction for recursively spawned forks. */
  agent?: Agent;
}

export interface SubagentExecutorDeps {
  /** Builds the pi agent after the executor has resolved model, prompt, skills, and tools. */
  createAgent(
    input: SubagentAgentConfigInput,
    onControlResult: (result: TurnRunnerControlResult) => void,
  ): Agent;
  /** Resolves a child skill allowlist and expands slash-skill prompts against it. */
  skillContext: {
    /** Resolves allowed skill names or returns undefined for an unrestricted child. */
    resolveSkills(spec: SubagentSpec, ctx: SubagentExecutionContext): Skill[] | undefined;
    /** Expands slash commands using only the skills available to this child. */
    resolveSlashSkillPrompt(prompt: string, skills: Skill[] | undefined): string;
    /** Rebuilds the system prompt when a fork restricts the parent's skill catalog. */
    createSystemPromptWithAppendedLayers(input: { skills: readonly Skill[] }): string;
  };
  /** Parent options copied into a child before per-spec model and effort overrides. */
  inheritedOptions(): TurnOptions;
  /** Resolves an explicit virtual model override to its existing default route. */
  resolveModel(
    model: string | undefined,
  ): Pick<ResolvedTarget, "modelName" | "thinkingLevel"> | undefined;
  /** Returns a snapshot of the parent transcript when forkContext is enabled. */
  seedMessages(spec: SubagentSpec, ctx: SubagentExecutionContext): AgentMessage[];
  /** Returns the byte-identical parent system prompt used by unrestricted forks. */
  parentSystemPrompt(ctx: SubagentExecutionContext): string | undefined;
  /** Creates coding tools using the child's resolved cwd. */
  createTools(cwd: string | undefined, ctx: SubagentExecutionContext): { tools: AgentTool[] };
  /** Retries the existing transient provider failures without changing child semantics. */
  retryTransientServerErrors(agent: Agent): Promise<void>;
  /** Cross transports only when this child has not emitted visible output or invoked a tool. */
  retryConnectedTransportFallback(agent: Agent, visibleOutput: () => boolean): Promise<void>;
  /** Streams pi events through the turn protocol with the child origin attached. */
  emitAgentEvent(event: AgentEvent, origin: TurnEventOrigin): void;
  /** Adds one child completion's usage to the turn aggregate. */
  recordUsage(
    usage: TurnTokenUsage | Usage | undefined,
    modelId: string | undefined,
    provider: TransportName | undefined,
  ): void;
  /** Emits the aggregate usage snapshot after a child completion. */
  emitTurnUsage(origin: TurnEventOrigin): void;
}

/** Build the single executor used by every internal sub-agent spec builder. */
export function createSubagentExecutor(deps: SubagentExecutorDeps) {
  return (spec: SubagentSpec, ctx: SubagentExecutionContext): SubagentRun => {
    const controls: TurnRunnerControlResult[] = [];
    const seedMessages = deps.seedMessages(spec, ctx);
    // Capture the seeded prefix length up front. The sub-agent's result,
    // partial text, and recorded usage are all computed by slicing this prefix
    // off agent.state.messages so a forked parent transcript isn't folded into
    // this run. Reading `seedMessages.length` lazily at each call site would be
    // wrong if the agent ever appended into the seed array in place, so snapshot
    // the count once.
    const seedMessageCount = seedMessages.length;
    const resolvedModel = deps.resolveModel(spec.model);
    const inheritedOptions = deps.inheritedOptions();
    const childModelOptions: TurnOptions = resolvedModel
      ? { model: resolvedModel.modelName, thinkingLevel: resolvedModel.thinkingLevel }
      : {
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
        };
    const state: TurnState = {
      status: "running",
      mode: "agent",
      options: {
        ...inheritedOptions,
        ...childModelOptions,
      },
      agent: {
        status: "running",
        messages: seedMessages,
      },
    };
    const childSkills = deps.skillContext.resolveSkills(spec, ctx);
    // Expand `/skill` slash commands the same way the parent prompt path does,
    // scoped to the skills this state is actually allowed to use. Lets state
    // prompts say "use the /foo skill to do xyz" and have the skill body
    // injected, instead of shipping the literal `/foo` text to the model.
    const expandedPrompt = deps.skillContext.resolveSlashSkillPrompt(spec.prompt, childSkills);
    const forkContext = spec.forkContext === true;
    const identityLayer = createStateAgentSystemPromptLayer(ctx.machineContext);
    // When forking, the sub-agent's identity + per-state systemPrompt layers
    // ride in the tail user turn so the system prompt can stay byte-identical to
    // the parent's and preserve the provider prompt-cache prefix. There is one
    // exception: a state that restricts skills via allowedSkills must NOT inherit
    // the parent's full skill catalog. resolveSkills returns undefined only for
    // an unrestricted state; when it returns a concrete allowlist we rebuild the
    // system prompt around that allowlist instead of reusing the parent's verbatim,
    // trading the cache prefix for the allowlist contract.
    const forkSystemPrompt = forkContext
      ? childSkills === undefined
        ? deps.parentSystemPrompt(ctx)
        : deps.skillContext.createSystemPromptWithAppendedLayers({ skills: childSkills })
      : undefined;
    const tailPrompt = forkContext
      ? [createForkContextReminder(), identityLayer, spec.systemPrompt, expandedPrompt]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : expandedPrompt;
    const agent = deps.createAgent(
      {
        state,
        ...(forkSystemPrompt ? { systemPrompt: forkSystemPrompt } : {}),
        prependSystemPrompt: forkContext ? undefined : identityLayer,
        appendSystemPrompt: forkContext ? undefined : spec.systemPrompt,
        skills: childSkills,
        ...deps.createTools(spec.cwd, ctx),
        ...(ctx.memoryContext ? { memoryContext: ctx.memoryContext } : {}),
      },
      (result) => {
        if (result.type === "none") return;
        if (controls.length > 0) {
          throw new Error("A sub-agent pass produced more than one control result.");
        }
        controls.push(result);
      },
    );
    ctx.agent = agent;
    let unsubscribe: (() => void) | undefined;
    let interruptedReason: string | undefined;
    const finish = (): SubagentResult => {
      const control = controls[0] ?? { type: "none" as const };
      if (control.type !== "none") {
        return { type: "failed", error: `Sub-agent emitted unsupported control: ${control.type}` };
      }
      if (agent.state.errorMessage) {
        return { type: "failed", error: agent.state.errorMessage };
      }
      return {
        type: "complete",
        result: assistantText(agent.state.messages.slice(seedMessageCount)),
      };
    };

    // A sub-agent runs a turn just like the parent — a loop of completion
    // calls — so it streams a `usage` event per completion from its own
    // `message_end` events. The finally block falls back to summing the whole
    // message list only when no `message_end` fired (stubbed-agent test path).
    let recordedMessageUsage = false;
    return {
      prompt: async () => {
        let visibleOutput = false;
        unsubscribe = agent.subscribe((event) => {
          if (isExternallyVisibleAgentEvent(event)) visibleOutput = true;
          deps.emitAgentEvent(event, ctx.origin);
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          deps.recordUsage(
            event.message.usage,
            event.message.model,
            event.message.provider as TransportName,
          );
          recordedMessageUsage = true;
          if (event.message.usage.totalTokens > 0) deps.emitTurnUsage(ctx.origin);
        });
        try {
          await agent.prompt(tailPrompt);
          await deps.retryConnectedTransportFallback(agent, () => visibleOutput);
          if (
            !isPostOutputConnectedFailure(
              agent.state.model.provider,
              agent.state.messages.at(-1),
              visibleOutput,
            )
          ) {
            await deps.retryTransientServerErrors(agent);
          }
          return interruptedReason ? { type: "interrupted" } : finish();
        } catch (error) {
          if (interruptedReason) return { type: "interrupted" };
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
          if (!recordedMessageUsage) {
            deps.recordUsage(
              usageFromMessages(agent.state.messages.slice(seedMessageCount)),
              agent.state.model.id,
              agent.state.model.provider as TransportName,
            );
            deps.emitTurnUsage(ctx.origin);
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
  };
}

export interface ClassifySpawnModelDeps {
  /** Active routing table used to distinguish concrete settings from virtual tiers. */
  table: RoutingTable;
  /** Concrete-model capability lookup used by the pure resolution kernel. */
  resolveCatalog: RouteResolutionCatalog;
  /** Provider-call settings for the stateless classifier. */
  classifierOptions: ClassifyRouteOptions;
  /** Test seam for the one classifier call; production uses classifyRoute directly. */
  classify?: typeof classifyRoute;
}

/** Concrete child target selected from the parent's model setting. */
export interface SpawnModelSelection {
  /** Concrete catalog name inherited or selected for child execution. */
  modelName: string;
  /** Route-owned effort, present only when a virtual setting selected it. */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve a child model without consulting the session's mutable ModelRouter.
 * Concrete settings inherit verbatim; virtual settings make one stateless
 * classify call on the child prompt and resolve that decision immediately.
 */
export async function classifySpawnModel(
  prompt: string,
  parentSetting: string,
  deps: ClassifySpawnModelDeps,
): Promise<SpawnModelSelection> {
  const tier = deps.table.tiers[parentSetting];
  if (!tier) return { modelName: parentSetting };

  const classify = deps.classify ?? classifyRoute;
  const decision: ClassifierDecision = await classify(
    {
      tierName: parentSetting,
      tier,
      guidance: deps.table.classifier.guidance,
      lastStepDelta: prompt,
      hasImages: false,
      trigger: "turn_start",
    },
    deps.classifierOptions,
  );
  const resolved = resolveRoute(
    deps.table,
    parentSetting,
    decision.route,
    { hasImages: false },
    deps.resolveCatalog,
  );
  return { modelName: resolved.modelName, thinkingLevel: resolved.thinkingLevel };
}
