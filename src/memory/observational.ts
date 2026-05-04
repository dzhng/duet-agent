import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { nanoid } from "nanoid";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
import type { MemoryStore } from "./store.js";
import type {
  Observation,
  ObservationPriority,
  ObservationalMemorySettings,
} from "../types/memory.js";
import {
  reconcileObservationGroupsFromReflection,
  renderObservationGroupsForReflection,
  stripObservationGroups,
  wrapInObservationGroup,
} from "./observation-groups.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  type RawMemoryMessage,
} from "./observational-prompts.js";

export const OBSERVATIONAL_MEMORY_DEFAULTS = {
  observation: {
    // Start converting raw conversation history into observations once the raw
    // message log reaches this approximate token count.
    messageTokens: 30_000,
    // Limit each observer call to a bounded slice of raw history so observation
    // generation stays predictable on very long sessions.
    maxTokensPerBatch: 10_000,
    // Keep this fraction of the raw-history budget after observations activate,
    // so the actor still sees the most recent unobserved conversation tail.
    bufferActivation: 0.8,
  },
  reflection: {
    // Condense the observation log once it reaches this approximate size.
    observationTokens: 40_000,
    // Keep this fraction of observationTokens after reflection, leaving room for
    // future observations before another reflection pass is needed.
    bufferActivation: 0.5,
  },
} as const;

export interface ObserverResult {
  /** New observation log text extracted from raw messages. */
  observations: string;
  /** Current task state distilled for continuity and optional thread metadata. */
  currentTask?: string;
  /** Hint for the actor's next response after context has been compressed. */
  suggestedContinuation?: string;
  /** Optional short title when the observer is asked to name the session/thread. */
  threadTitle?: string;
}

function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
}

export interface ReflectorResult {
  /** Condensed observation log produced from existing observations. */
  observations: string;
  /** Hint for the actor's next response after reflection rewrites memory. */
  suggestedContinuation?: string;
}

const observerResultSchema = Type.Object({
  observations: Type.String({
    description:
      "New observation log text extracted from the raw message history. Return an empty string if there are no useful new observations.",
  }),
  currentTask: Type.Optional(
    Type.String({ description: "Current task state distilled for continuity." }),
  ),
  suggestedContinuation: Type.Optional(
    Type.String({ description: "Hint for the actor's next response after context compression." }),
  ),
  threadTitle: Type.Optional(
    Type.String({ description: "Short 2-5 word title when thread title generation is requested." }),
  ),
});

const observerResultTool = {
  name: "recordObservations",
  description: "Return extracted observational memory fields.",
  parameters: observerResultSchema,
};

const reflectorResultSchema = Type.Object({
  observations: Type.String({
    description:
      "Condensed observation log preserving important facts, dates, preferences, unresolved work, and completion markers.",
  }),
  suggestedContinuation: Type.Optional(
    Type.String({
      description: "Hint for the actor's next response after reflection rewrites memory.",
    }),
  ),
});

const reflectorResultTool = {
  name: "reflectObservations",
  description: "Return condensed observational memory fields.",
  parameters: reflectorResultSchema,
};

export interface ModelByInputTokensConfig {
  upTo: Record<number, Model<any>>;
}

export class ModelByInputTokens {
  private readonly thresholds: Array<{ limit: number; model: Model<any> }>;

  constructor(config: ModelByInputTokensConfig) {
    const entries = Object.entries(config.upTo);
    if (entries.length === 0) {
      throw new Error('ModelByInputTokens requires at least one threshold in "upTo"');
    }
    this.thresholds = entries
      .map(([limit, model]) => {
        const parsed = Number(limit);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(
            `ModelByInputTokens threshold keys must be positive numbers. Got: ${limit}`,
          );
        }
        return { limit: parsed, model };
      })
      .sort((a, b) => a.limit - b.limit);
  }

  resolve(inputTokens: number): Model<any> {
    for (const { limit, model } of this.thresholds) {
      if (inputTokens <= limit) {
        return model;
      }
    }
    const maxLimit = this.thresholds[this.thresholds.length - 1]!.limit;
    throw new Error(
      `ModelByInputTokens: input token count (${inputTokens}) exceeds the largest configured threshold (${maxLimit}).`,
    );
  }

  getThresholds(): number[] {
    return this.thresholds.map((threshold) => threshold.limit);
  }
}

export interface ObservationalMemoryTransformOptions {
  memory: MemoryStore;
  actorModel: Model<any>;
  settings?: boolean | Partial<ObservationalMemorySettings>;
}

export function resolveObservationalMemorySettings(
  actorModel: Model<any>,
  input?: boolean | Partial<ObservationalMemorySettings>,
): ObservationalMemorySettings {
  const partial =
    input === true || input === undefined ? {} : input === false ? { enabled: false } : input;
  const model = partial.model ?? actorModel;

  return {
    enabled: partial.enabled ?? true,
    scope: partial.scope ?? "session",
    model,
    observation: {
      model: partial.observation?.model ?? model,
      messageTokens:
        partial.observation?.messageTokens ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.messageTokens,
      maxTokensPerBatch:
        partial.observation?.maxTokensPerBatch ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.maxTokensPerBatch,
      bufferActivation:
        partial.observation?.bufferActivation ??
        OBSERVATIONAL_MEMORY_DEFAULTS.observation.bufferActivation,
      blockAfter: partial.observation?.blockAfter,
      previousObserverTokens: partial.observation?.previousObserverTokens,
      instruction: partial.observation?.instruction,
      threadTitle: partial.observation?.threadTitle,
    },
    reflection: {
      model: partial.reflection?.model ?? model,
      observationTokens:
        partial.reflection?.observationTokens ??
        OBSERVATIONAL_MEMORY_DEFAULTS.reflection.observationTokens,
      bufferActivation:
        partial.reflection?.bufferActivation ??
        OBSERVATIONAL_MEMORY_DEFAULTS.reflection.bufferActivation,
      blockAfter: partial.reflection?.blockAfter,
      instruction: partial.reflection?.instruction,
    },
    retrieval: partial.retrieval ?? false,
    shareTokenBudget: partial.shareTokenBudget ?? false,
    temporalMarkers: partial.temporalMarkers ?? false,
    activateAfterIdle: partial.activateAfterIdle,
    activateOnProviderChange: partial.activateOnProviderChange ?? false,
  };
}

export function validateObservationalMemorySettings(settings: ObservationalMemorySettings): void {
  if (
    settings.observation.bufferActivation <= 0 ||
    (settings.observation.bufferActivation > 1 && settings.observation.bufferActivation < 1000)
  ) {
    throw new Error(
      `observation.bufferActivation must be <= 1 (ratio) or >= 1000 (absolute retention), got ${settings.observation.bufferActivation}`,
    );
  }

  if (settings.reflection.bufferActivation <= 0 || settings.reflection.bufferActivation > 1) {
    throw new Error(
      `reflection.bufferActivation must be in range (0, 1], got ${settings.reflection.bufferActivation}`,
    );
  }
}

export function createObservationalMemoryTransform(options: ObservationalMemoryTransformOptions) {
  const settings = resolveObservationalMemorySettings(options.actorModel, options.settings);
  validateObservationalMemorySettings(settings);

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (!settings.enabled) return messages;

    const rawMessages = agentMessagesToRaw(messages);
    const rawTokens = estimateRawTokens(rawMessages);
    let retainedMessages = messages;

    if (rawTokens >= settings.observation.messageTokens) {
      const retainedRawMessages = await activateObservations(
        options.memory,
        rawMessages,
        settings,
        signal,
      );
      retainedMessages = retainAgentMessageTail(messages, retainedRawMessages);
    }

    const snapshot = await options.memory.getSnapshot();
    const observationTokens = snapshot.estimatedTokens.observations;
    if (observationTokens >= settings.reflection.observationTokens) {
      await reflectObservations(options.memory, settings, signal);
    }

    const refreshed = await options.memory.getSnapshot();
    const observations = refreshed.observations
      .map((observation) => observation.content)
      .join("\n\n");
    if (!observations.trim()) {
      return retainedMessages;
    }

    return [
      buildObservationContextMessage(observations),
      buildContinuationMessage(),
      ...retainedMessages,
    ];
  };
}

export function optimizeObservationsForContext(observations: string): string {
  let optimized = stripObservationGroups(observations);
  optimized = optimized.replace(/🟡\s*/g, "");
  optimized = optimized.replace(/🟢\s*/g, "");
  optimized = optimized.replace(/\[(?![\d\s]*items collapsed)[^\]]+\]/g, "");
  optimized = optimized.replace(/\s*->\s*/g, " ");
  optimized = optimized.replace(/ +/g, " ");
  optimized = optimized.replace(/\n{3,}/g, "\n\n");
  return optimized.trim();
}

function buildObservationContextMessage(observations: string): AgentMessage {
  const optimized = optimizeObservationsForContext(observations);
  return {
    role: "user",
    content: `<system-reminder>${OBSERVATION_CONTEXT_PROMPT}\n\n<observations>\n${optimized}\n</observations>\n\n${OBSERVATION_CONTEXT_INSTRUCTIONS}</system-reminder>`,
    timestamp: Date.now(),
  };
}

function buildContinuationMessage(): AgentMessage {
  return {
    role: "user",
    content: `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
    timestamp: Date.now(),
  };
}

async function activateObservations(
  store: MemoryStore,
  messages: RawMemoryMessage[],
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal,
): Promise<RawMemoryMessage[]> {
  const snapshot = await store.getSnapshot();
  const observations = (await observe(messages, snapshot.observations, settings, _signal))
    .observations;

  if (!observations.trim()) {
    return messages;
  }

  const range = `${messages[0]?.id ?? "unknown"}:${messages[messages.length - 1]?.id ?? "unknown"}`;
  await store.appendObservation({
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: inferPriority(observations),
    scope: settings.scope,
    source: { kind: "system" },
    content: wrapInObservationGroup(observations, range),
    tags: ["observational-memory"],
  });

  const retainedRawMessages = retainRawTail(
    messages,
    settings.observation.bufferActivation,
    settings.observation.messageTokens,
  );
  return retainedRawMessages;
}

async function reflectObservations(
  store: MemoryStore,
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal,
): Promise<void> {
  const snapshot = await store.getSnapshot();
  const source = snapshot.observations.map((observation) => observation.content).join("\n\n");
  const rendered = renderObservationGroupsForReflection(source) ?? source;
  const model = settings.reflection.model ?? settings.model;
  const result = await generateStructuredOutput({
    model: model!,
    tool: reflectorResultTool,
    systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction),
    prompt: buildReflectorPrompt(rendered),
  });
  const text = sanitizeObservationLines(result.observations.trim());
  if (!text) {
    return;
  }

  const reconciled = reconcileObservationGroupsFromReflection(text, source) ?? text;
  const reflected: Observation = {
    id: createMemoryId(),
    createdAt: Date.now(),
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: "high",
    scope: settings.scope,
    source: { kind: "system" },
    content: reconciled,
    tags: ["observational-memory", "reflection"],
  };
  await store.replaceObservations([reflected]);
}

async function observe(
  messages: RawMemoryMessage[],
  previousObservations: Observation[],
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal,
): Promise<ObserverResult> {
  const model = settings.observation.model ?? settings.model;
  const result = await generateStructuredOutput({
    model: model!,
    tool: observerResultTool,
    systemPrompt: buildObserverSystemPrompt(
      settings.observation.instruction,
      settings.observation.threadTitle,
    ),
    prompt: buildObserverPrompt(
      messages,
      previousObservations.map((observation) => observation.content).join("\n\n"),
    ),
  });
  return {
    ...result,
    observations: sanitizeObservationLines(result.observations),
  };
}

function retainRawTail(
  messages: RawMemoryMessage[],
  activation: number,
  messageTokens: number,
): RawMemoryMessage[] {
  const retainTokens = activation <= 1 ? Math.floor(messageTokens * (1 - activation)) : activation;
  let tokens = 0;
  const retained: RawMemoryMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    tokens += message.estimatedTokens ?? estimateTokens(message.content);
    if (tokens > retainTokens) break;
    retained.unshift(message);
  }
  return retained;
}

function retainAgentMessageTail(
  messages: AgentMessage[],
  retainedRawMessages: RawMemoryMessage[],
): AgentMessage[] {
  if (retainedRawMessages.length === 0) {
    return [];
  }
  const retainedIds = new Set(retainedRawMessages.map((message) => message.id));
  return messages.filter((message) => {
    const raw = agentMessageToRaw(message);
    return raw ? retainedIds.has(raw.id) : false;
  });
}

function agentMessagesToRaw(messages: AgentMessage[]): RawMemoryMessage[] {
  return messages
    .map((message) => agentMessageToRaw(message))
    .filter((message): message is RawMemoryMessage => Boolean(message));
}

function agentMessageToRaw(message: AgentMessage): RawMemoryMessage | undefined {
  const content = messageToText(message);
  if (content.trim().length === 0) {
    return undefined;
  }
  return {
    id: stableRawMessageId(message),
    createdAt:
      "timestamp" in message && typeof message.timestamp === "number"
        ? message.timestamp
        : Date.now(),
    role: normalizeRole(String(message.role)),
    content,
    estimatedTokens: estimateTokens(content),
  };
}

function stableRawMessageId(message: AgentMessage): RawMemoryMessage["id"] {
  if (message.role === "assistant" && "responseId" in message && message.responseId) {
    return `msg_assistant_${message.responseId}`;
  }
  if (message.role === "toolResult" && "toolCallId" in message) {
    return `msg_tool_${message.toolCallId}`;
  }
  const timestamp =
    "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return `msg_${String(message.role)}_${timestamp}_${hashText(messageToText(message))}`;
}

function normalizeRole(role: string): RawMemoryMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  if (role === "toolResult" || role === "toolCall") {
    return "tool";
  }
  return "system";
}

function messageToText(message: AgentMessage): string {
  const maybeContent = (message as { content?: unknown }).content;
  if (typeof maybeContent === "string") return maybeContent;
  if (Array.isArray(maybeContent)) {
    return maybeContent
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if ("summary" in message && typeof message.summary === "string") {
    return message.summary;
  }
  return "";
}

const MAX_OBSERVATION_LINE_CHARS = 10_000;

export function sanitizeObservationLines(observations: string): string {
  if (!observations) return observations;
  let changed = false;
  const lines = observations.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > MAX_OBSERVATION_LINE_CHARS) {
      lines[i] = lines[i]!.slice(0, MAX_OBSERVATION_LINE_CHARS) + " … [truncated]";
      changed = true;
    }
  }
  return changed ? lines.join("\n") : observations;
}

function inferPriority(observations: string): ObservationPriority {
  if (observations.includes("🔴") || observations.includes("✅")) return "high";
  if (observations.includes("🟡")) return "medium";
  return "low";
}

function estimateRawTokens(messages: RawMemoryMessage[]): number {
  return messages.reduce(
    (total, message) => total + (message.estimatedTokens ?? estimateTokens(message.content)),
    0,
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
