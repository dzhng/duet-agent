import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { createMemoryId } from "../core/ids.js";
import type {
  MemoryStorage,
  Observation,
  ObservationPriority,
  ObservationalMemorySettings,
  RawMemoryMessage,
  SessionId,
} from "../core/types.js";
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
  OBSERVER_GUIDELINES,
  buildObserverOutputFormat,
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  formatMessagesForObserver,
} from "./observational-prompts.js";

export {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
  OBSERVER_GUIDELINES,
  buildObserverOutputFormat,
  buildObserverPrompt,
  buildObserverSystemPrompt,
  buildReflectorPrompt,
  buildReflectorSystemPrompt,
  formatMessagesForObserver,
} from "./observational-prompts.js";

export const OBSERVATIONAL_MEMORY_DEFAULTS = {
  observation: {
    messageTokens: 30_000,
    maxTokensPerBatch: 10_000,
    bufferTokens: 0.2 as number | false,
    bufferActivation: 0.8,
  },
  reflection: {
    observationTokens: 40_000,
    bufferActivation: 0.5,
  },
} as const;

export interface ObserverResult {
  observations: string;
  currentTask?: string;
  suggestedContinuation?: string;
  threadTitle?: string;
  degenerate?: boolean;
}

export interface ReflectorResult {
  observations: string;
  suggestedContinuation?: string;
  degenerate?: boolean;
}

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
          throw new Error(`ModelByInputTokens threshold keys must be positive numbers. Got: ${limit}`);
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
      `ModelByInputTokens: input token count (${inputTokens}) exceeds the largest configured threshold (${maxLimit}).`
    );
  }

  getThresholds(): number[] {
    return this.thresholds.map((threshold) => threshold.limit);
  }
}

export interface ObservationalMemoryTransformOptions {
  store: MemoryStorage;
  sessionId: SessionId;
  actorModel: Model<any>;
  settings?: boolean | Partial<ObservationalMemorySettings>;
}

export function resolveObservationalMemorySettings(
  actorModel: Model<any>,
  input?: boolean | Partial<ObservationalMemorySettings>
): ObservationalMemorySettings {
  const partial = input === true || input === undefined ? {} : input === false ? { enabled: false } : input;
  const model = partial.model ?? actorModel;

  return {
    enabled: partial.enabled ?? true,
    scope: partial.scope ?? "session",
    model,
    observation: {
      model: partial.observation?.model ?? model,
      messageTokens: partial.observation?.messageTokens ?? OBSERVATIONAL_MEMORY_DEFAULTS.observation.messageTokens,
      maxTokensPerBatch:
        partial.observation?.maxTokensPerBatch ?? OBSERVATIONAL_MEMORY_DEFAULTS.observation.maxTokensPerBatch,
      bufferTokens: partial.observation?.bufferTokens ?? OBSERVATIONAL_MEMORY_DEFAULTS.observation.bufferTokens,
      bufferActivation:
        partial.observation?.bufferActivation ?? OBSERVATIONAL_MEMORY_DEFAULTS.observation.bufferActivation,
      blockAfter: partial.observation?.blockAfter,
      previousObserverTokens: partial.observation?.previousObserverTokens,
      instruction: partial.observation?.instruction,
      threadTitle: partial.observation?.threadTitle,
    },
    reflection: {
      model: partial.reflection?.model ?? model,
      observationTokens:
        partial.reflection?.observationTokens ?? OBSERVATIONAL_MEMORY_DEFAULTS.reflection.observationTokens,
      bufferActivation:
        partial.reflection?.bufferActivation ?? OBSERVATIONAL_MEMORY_DEFAULTS.reflection.bufferActivation,
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
  if (settings.shareTokenBudget && settings.observation.bufferTokens !== false) {
    throw new Error(
      "shareTokenBudget requires async buffering to be disabled. Set observation.bufferTokens to false."
    );
  }

  if (settings.observation.bufferTokens !== false) {
    const bufferTokens = resolveBufferTokens(settings.observation.bufferTokens, settings.observation.messageTokens);
    if (bufferTokens <= 0 || bufferTokens >= settings.observation.messageTokens) {
      throw new Error(
        `observation.bufferTokens (${bufferTokens}) must be greater than 0 and less than messageTokens (${settings.observation.messageTokens})`
      );
    }
  }

  if (
    settings.observation.bufferActivation <= 0 ||
    (settings.observation.bufferActivation > 1 && settings.observation.bufferActivation < 1000)
  ) {
    throw new Error(
      `observation.bufferActivation must be <= 1 (ratio) or >= 1000 (absolute retention), got ${settings.observation.bufferActivation}`
    );
  }

  if (settings.reflection.bufferActivation <= 0 || settings.reflection.bufferActivation > 1) {
    throw new Error(
      `reflection.bufferActivation must be in range (0, 1], got ${settings.reflection.bufferActivation}`
    );
  }
}

export function createObservationalMemoryTransform(options: ObservationalMemoryTransformOptions) {
  const settings = resolveObservationalMemorySettings(options.actorModel, options.settings);
  validateObservationalMemorySettings(settings);

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (!settings.enabled) return messages;

    const rawMessages = agentMessagesToRaw(options.sessionId, messages);
    const rawTokens = estimateRawTokens(rawMessages);
    await options.store.replaceRawMessages(options.sessionId, rawMessages);
    let retainedMessages = messages;

    if (shouldBuffer(settings, rawTokens)) {
      await maybeBufferObservations(options.store, options.sessionId, rawMessages, settings, signal);
    }

    if (rawTokens >= settings.observation.messageTokens) {
      const retainedRawMessages = await activateObservations(options.store, options.sessionId, rawMessages, settings, signal);
      retainedMessages = retainAgentMessageTail(messages, retainedRawMessages);
    }

    const snapshot = await options.store.getSnapshot(options.sessionId);
    const observationTokens = snapshot.observations.estimatedTokens ?? 0;
    if (observationTokens >= settings.reflection.observationTokens) {
      await reflectObservations(options.store, options.sessionId, settings, signal);
    }

    const refreshed = await options.store.getSnapshot(options.sessionId);
    const observations = refreshed.observations.observations.map((observation) => observation.content).join("\n\n");
    if (!observations.trim()) {
      return retainedMessages;
    }

    return [buildObservationContextMessage(observations), buildContinuationMessage(), ...retainedMessages];
  };
}

export function parseObserverOutput(output: string): ObserverResult {
  if (detectDegenerateRepetition(output)) {
    return { observations: "", degenerate: true };
  }

  const result: ObserverResult = { observations: "" };
  const observationsMatches = [...output.matchAll(/^[ \t]*<observations>([\s\S]*?)^[ \t]*<\/observations>/gim)];
  if (observationsMatches.length > 0) {
    result.observations = observationsMatches
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
  } else {
    result.observations = extractListItemsOnly(output);
  }

  const currentTaskMatch = output.match(/^[ \t]*<current-task>([\s\S]*?)^[ \t]*<\/current-task>/im);
  if (currentTaskMatch?.[1]) {
    result.currentTask = currentTaskMatch[1].trim();
  }

  const suggestedResponseMatch = output.match(
    /^[ \t]*<suggested-response>([\s\S]*?)^[ \t]*<\/suggested-response>/im
  );
  if (suggestedResponseMatch?.[1]) {
    result.suggestedContinuation = suggestedResponseMatch[1].trim();
  }

  const threadTitleMatch = output.match(/^[ \t]*<thread-title>([\s\S]*?)<\/thread-title>/im);
  if (threadTitleMatch?.[1]) {
    result.threadTitle = threadTitleMatch[1].trim();
  }

  result.observations = sanitizeObservationLines(result.observations);
  return result;
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

async function maybeBufferObservations(
  store: MemoryStorage,
  sessionId: SessionId,
  messages: RawMemoryMessage[],
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal
): Promise<void> {
  const snapshot = await store.getSnapshot(sessionId);
  if (snapshot.buffered.some((chunk) => chunk.status === "pending")) {
    return;
  }

  const result = await observe(messages, snapshot.observations.observations, settings, _signal);
  if (!result.observations.trim() || result.degenerate) {
    return;
  }

  await store.appendBufferedObservation({
    sessionId,
    observations: result.observations,
    messageTokenCount: estimateRawTokens(messages),
    observationTokenCount: estimateTokens(result.observations),
    messageIds: messages.map((message) => message.id),
    status: "pending",
  });
}

async function activateObservations(
  store: MemoryStorage,
  sessionId: SessionId,
  messages: RawMemoryMessage[],
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal
): Promise<RawMemoryMessage[]> {
  const snapshot = await store.getSnapshot(sessionId);
  const pending = snapshot.buffered.filter((chunk) => chunk.status === "pending");
  const observations = pending.length > 0
    ? pending.map((chunk) => chunk.observations).join("\n\n")
    : (await observe(messages, snapshot.observations.observations, settings, _signal)).observations;

  if (!observations.trim()) {
    return messages;
  }

  const range = `${messages[0]?.id ?? "unknown"}:${messages[messages.length - 1]?.id ?? "unknown"}`;
  await store.appendObservation({
    sessionId,
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: inferPriority(observations),
    scope: settings.scope,
    source: { kind: "system" },
    content: wrapInObservationGroup(observations, range),
    tags: ["observational-memory"],
  });

  await store.replaceBufferedObservations(
    sessionId,
    snapshot.buffered.map((chunk) => pending.some((item) => item.id === chunk.id) ? { ...chunk, status: "active" } : chunk)
  );
  const retainedRawMessages = retainRawTail(messages, settings.observation.bufferActivation, settings.observation.messageTokens);
  await store.replaceRawMessages(sessionId, retainedRawMessages);
  return retainedRawMessages;
}

async function reflectObservations(
  store: MemoryStorage,
  sessionId: SessionId,
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal
): Promise<void> {
  const snapshot = await store.getSnapshot(sessionId);
  const source = snapshot.observations.observations.map((observation) => observation.content).join("\n\n");
  const rendered = renderObservationGroupsForReflection(source) ?? source;
  const model = settings.reflection.model ?? settings.model;
  const response = await completeSimple(model!, {
    systemPrompt: buildReflectorSystemPrompt(settings.reflection.instruction),
    messages: [{ role: "user", content: buildReflectorPrompt(rendered), timestamp: Date.now() }],
  });
  const text = assistantText([response]).trim();
  if (!text || detectDegenerateRepetition(text)) {
    return;
  }

  const reconciled = reconcileObservationGroupsFromReflection(text, source) ?? text;
  const reflected: Observation = {
    id: createMemoryId(),
    sessionId,
    createdAt: Date.now(),
    observedDate: new Date().toISOString().slice(0, 10),
    timeOfDay: new Date().toISOString().slice(11, 16),
    priority: "high",
    scope: settings.scope,
    source: { kind: "system" },
    content: reconciled,
    tags: ["observational-memory", "reflection"],
  };
  await store.replaceObservations(sessionId, [reflected]);
}

async function observe(
  messages: RawMemoryMessage[],
  previousObservations: Observation[],
  settings: ObservationalMemorySettings,
  _signal?: AbortSignal
): Promise<ObserverResult> {
  const model = settings.observation.model ?? settings.model;
  const response = await completeSimple(model!, {
    systemPrompt: buildObserverSystemPrompt(settings.observation.instruction, settings.observation.threadTitle),
    messages: [
      {
        role: "user",
        content: buildObserverPrompt(
          messages,
          previousObservations.map((observation) => observation.content).join("\n\n")
        ),
        timestamp: Date.now(),
      },
    ],
  });
  return parseObserverOutput(assistantText([response]));
}

function shouldBuffer(settings: ObservationalMemorySettings, rawTokens: number): boolean {
  if (settings.observation.bufferTokens === false) return false;
  const threshold = resolveBufferTokens(settings.observation.bufferTokens, settings.observation.messageTokens);
  return rawTokens >= threshold && rawTokens < settings.observation.messageTokens;
}

function resolveBufferTokens(value: number | false, messageTokens: number): number {
  if (value === false) return Number.POSITIVE_INFINITY;
  return value > 0 && value < 1 ? Math.floor(messageTokens * value) : value;
}

function retainRawTail(
  messages: RawMemoryMessage[],
  activation: number,
  messageTokens: number
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
  retainedRawMessages: RawMemoryMessage[]
): AgentMessage[] {
  if (retainedRawMessages.length === 0) {
    return [];
  }
  const retainedIds = new Set(retainedRawMessages.map((message) => message.id));
  return messages.filter((message) => {
    const raw = agentMessageToRaw(undefined, message);
    return raw ? retainedIds.has(raw.id) : false;
  });
}

function agentMessagesToRaw(sessionId: SessionId, messages: AgentMessage[]): RawMemoryMessage[] {
  return messages
    .map((message) => agentMessageToRaw(sessionId, message))
    .filter((message): message is RawMemoryMessage => Boolean(message));
}

function agentMessageToRaw(sessionId: SessionId | undefined, message: AgentMessage): RawMemoryMessage | undefined {
  const content = messageToText(message);
  if (content.trim().length === 0) {
    return undefined;
  }
  return {
    id: stableRawMessageId(message),
    sessionId: sessionId ?? ("" as SessionId),
    createdAt: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    role: normalizeRole(String(message.role)),
    content,
    estimatedTokens: estimateTokens(content),
  };
}

function stableRawMessageId(message: AgentMessage): RawMemoryMessage["id"] {
  if (message.role === "assistant" && "responseId" in message && message.responseId) {
    return `msg_assistant_${message.responseId}` as RawMemoryMessage["id"];
  }
  if (message.role === "toolResult" && "toolCallId" in message) {
    return `msg_tool_${message.toolCallId}` as RawMemoryMessage["id"];
  }
  const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return `msg_${String(message.role)}_${timestamp}_${hashText(messageToText(message))}` as RawMemoryMessage["id"];
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

function assistantText(messages: AgentMessage[]): string {
  return messages
    .flatMap((message) => (Array.isArray((message as { content?: unknown }).content) ? (message as { content: any[] }).content : []))
    .filter((block) => block?.type === "text")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function extractListItemsOnly(content: string): string {
  return content
    .split("\n")
    .filter((line) => /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line))
    .join("\n")
    .trim();
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

export function detectDegenerateRepetition(text: string): boolean {
  if (!text || text.length < 2000) return false;

  const windowSize = 200;
  const step = Math.max(1, Math.floor(text.length / 50));
  const seen = new Map<string, number>();
  let duplicateWindows = 0;
  let totalWindows = 0;

  for (let i = 0; i + windowSize <= text.length; i += step) {
    const window = text.slice(i, i + windowSize);
    totalWindows++;
    const count = (seen.get(window) ?? 0) + 1;
    seen.set(window, count);
    if (count > 1) duplicateWindows++;
  }

  if (totalWindows > 5 && duplicateWindows / totalWindows > 0.4) {
    return true;
  }

  return text.split("\n").some((line) => line.length > 50_000);
}

function inferPriority(observations: string): ObservationPriority {
  if (observations.includes("🔴") || observations.includes("✅")) return "high";
  if (observations.includes("🟡")) return "medium";
  return "low";
}

function estimateRawTokens(messages: RawMemoryMessage[]): number {
  return messages.reduce((total, message) => total + (message.estimatedTokens ?? estimateTokens(message.content)), 0);
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
