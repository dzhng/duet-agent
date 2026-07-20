import type { Context, ImageContent, Message, Tool } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentState } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../memory/observational.js";
import { IMAGE_WIRE_TOKEN_ESTIMATE } from "../turn-runner/wire-shaping.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompts.js";

const CONTEXT_OPEN = "<executor_context>";
const CONTEXT_CLOSE = "</executor_context>";

/** Minimal live-agent surface needed to capture the executor request faithfully. */
export interface AdvisorContextSource {
  /** Current prompt, transcript, tools, and any partial assistant message. */
  state: Pick<AgentState, "systemPrompt" | "messages" | "tools" | "streamingMessage">;
  /** Same custom-message conversion used before normal executor model calls. */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
}

/** The executor request data the advisor is allowed to inspect. */
export interface AdvisorExecutorContext {
  /** Fully resolved system prompt used by the executor. */
  systemPrompt: string;
  /** LLM-compatible transcript, including thinking, tool calls, and tool results. */
  messages: readonly Message[];
  /** Exact tool definitions available to the executor for the current turn. */
  tools: readonly Tool[];
}

/** Inputs for fitting the executor context into the advisor model's real request window. */
export interface BuildAdvisorContextInput {
  /** Wire-compatible executor context captured when ask_advisor executes. */
  context: AdvisorExecutorContext;
  /** Hard context window advertised by the resolved advisor model. */
  contextWindowTokens: number;
  /** Configured advisor output allowance, reserved from the shared context window. */
  reservedOutputTokens: number;
}

/** Telemetry describing exactly how the advisor request was bounded. */
export interface AdvisorContextMetadata {
  /** Advisor model's advertised input-plus-output context window. */
  contextWindowTokens: number;
  /** Output allowance kept free when calculating the input ceiling. */
  reservedOutputTokens: number;
  /** Maximum estimated tokens available to the quoted executor context. */
  inputLimitTokens: number;
  /** Heuristic token estimate including the shared coarse per-image charge. */
  estimatedInputTokens: number;
  /** Number of executor messages included in the serialized context. */
  includedMessages: number;
  /** Number of older executor messages omitted at whole-message boundaries. */
  omittedMessages: number;
  /** True only when the advisor model's real window forced message omission. */
  truncated: boolean;
  /** Images forwarded as multimodal parts rather than flattened into base64 text. */
  attachedImages: number;
}

/** Serialized advisor prompt plus request-window telemetry. */
export interface AdvisorContext {
  /** Quoted structured executor context sent as advisor-call content. */
  text: string;
  /** Original image blocks attached to the advisor request in transcript order. */
  images: readonly ImageContent[];
  /** Request-window accounting for logs, tool details, and previews. */
  metadata: AdvisorContextMetadata;
}

/**
 * Capture one live agent context for both production calls and CLI previews.
 * Tool execution normally starts after the assistant message is finalized; the
 * streaming fallback also preserves a partial turn for callers at other phases.
 */
export async function captureAdvisorExecutorContext(
  source: AdvisorContextSource,
): Promise<AdvisorExecutorContext> {
  const messages = [...source.state.messages];
  const streamingMessage = source.state.streamingMessage;
  if (streamingMessage && messages.at(-1) !== streamingMessage) {
    messages.push(streamingMessage);
  }
  return {
    systemPrompt: source.state.systemPrompt,
    messages: await source.convertToLlm(messages),
    tools: source.state.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  };
}

/**
 * Serialize the actual executor context without observer projection. When the
 * advisor model cannot fit it, remove only the oldest complete messages; tool
 * definitions, the resolved system prompt, and retained message structures
 * remain intact. Image bytes travel as matching multimodal attachments.
 */
export function buildAdvisorContext(input: BuildAdvisorContextInput): AdvisorContext {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens);
  const reservedOutputTokens = Math.min(
    positiveInteger(input.reservedOutputTokens),
    Math.max(0, contextWindowTokens - 1),
  );
  const advisorSystemTokens = estimateTokens(ADVISOR_SYSTEM_PROMPT);
  const inputLimitTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens - advisorSystemTokens,
  );
  let messages = [...input.context.messages];
  let serialized = serializeContext(input.context.systemPrompt, input.context.tools, messages, 0);
  const firstUserMessage = messages.find((message) => message.role === "user");
  while (
    messages.length > (firstUserMessage ? 1 : 0) &&
    estimateSerializedTokens(serialized) > inputLimitTokens
  ) {
    const removableIndex = messages.findIndex((message) => message !== firstUserMessage);
    if (removableIndex < 0) break;
    messages = [...messages.slice(0, removableIndex), ...messages.slice(removableIndex + 1)];
    serialized = serializeContext(
      input.context.systemPrompt,
      input.context.tools,
      messages,
      input.context.messages.length - messages.length,
    );
  }

  if (estimateSerializedTokens(serialized) > inputLimitTokens) {
    throw new Error(
      "Advisor context window is too small for the pinned task, system prompt, and tool definitions.",
    );
  }

  const omittedMessages = input.context.messages.length - messages.length;
  return {
    text: serialized.text,
    images: serialized.images,
    metadata: {
      contextWindowTokens,
      reservedOutputTokens,
      inputLimitTokens,
      estimatedInputTokens: advisorSystemTokens + estimateSerializedTokens(serialized),
      includedMessages: messages.length,
      omittedMessages,
      truncated: omittedMessages > 0,
      attachedImages: serialized.images.length,
    },
  };
}

function serializeContext(
  systemPrompt: string,
  tools: readonly Tool[],
  messages: readonly Message[],
  omittedMessages: number,
): { text: string; images: ImageContent[] } {
  const context: Context = {
    systemPrompt,
    tools: [...tools],
    messages: [...messages],
  };
  const images: ImageContent[] = [];
  const payload = {
    truncation: { omittedMessages },
    executorContext: context,
  };
  const json = JSON.stringify(payload, (key, value: unknown) => {
    if (key === "" && value === payload) return value;
    if (!isImageContent(value)) return value;
    const attachmentIndex = images.push(value) - 1;
    return { type: "image", mimeType: value.mimeType, attachmentIndex };
  });
  return { text: `${CONTEXT_OPEN}\n${json}\n${CONTEXT_CLOSE}`, images };
}

function isImageContent(value: unknown): value is ImageContent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

function estimateSerializedTokens(serialized: {
  text: string;
  images: readonly ImageContent[];
}): number {
  return estimateTokens(serialized.text) + serialized.images.length * IMAGE_WIRE_TOKEN_ESTIMATE;
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}
