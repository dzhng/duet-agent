import type { ImageContent, Message, Tool } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentState } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../memory/observational.js";
import { IMAGE_WIRE_TOKEN_ESTIMATE } from "../turn-runner/wire-shaping.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompts.js";

const CONTEXT_OPEN = "<executor_context>";
const CONTEXT_CLOSE = "</executor_context>";

/**
 * Soft total-input target above which observational compaction becomes cheaper
 * than forwarding the complete transcript to a typical two-review advisor
 * turn. The hard model window remains the final safety ceiling.
 */
export const ADVISOR_INPUT_TARGET_TOKENS = 64_000;

/**
 * Recent raw executor-message allowance kept beside compacted observations.
 * The newest complete tool interaction remains protected even when it exceeds
 * this target, so the allowance buys ordinary continuity without clipping the
 * evidence the advisor was called to inspect.
 */
export const ADVISOR_RECENT_MESSAGE_TARGET_TOKENS = 8_000;

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
  /** Raw executor messages represented by observational context instead of repeated verbatim. */
  compactedMessages?: number;
}

/** Optional advisor-only projection applied before conversion to provider messages. */
export interface CaptureAdvisorContextOptions {
  /** Replaces older history with normal observational context and a recent raw tail. */
  transformMessages: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
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
  /** Conservative slack retained for provider-tokenizer differences and request framing. */
  safetyMarginTokens: number;
  /** Maximum estimated tokens available to the quoted executor context. */
  inputLimitTokens: number;
  /** Preferred total advisor input; the hard model limit remains a safety ceiling. */
  inputTargetTokens: number;
  /** Heuristic token estimate including the shared coarse per-image charge. */
  estimatedInputTokens: number;
  /** Number of executor messages included in the serialized context. */
  includedMessages: number;
  /** Raw executor messages represented by observational context rather than copied verbatim. */
  compactedMessages: number;
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
  options?: CaptureAdvisorContextOptions,
): Promise<AdvisorExecutorContext> {
  const messages = [...source.state.messages];
  const streamingMessage = source.state.streamingMessage;
  if (streamingMessage && messages.at(-1) !== streamingMessage) {
    messages.push(streamingMessage);
  }
  let selectedMessages = options ? await options.transformMessages(messages) : messages;
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (firstUserMessage && !selectedMessages.includes(firstUserMessage)) {
    selectedMessages = [firstUserMessage, ...selectedMessages];
  }
  const compactedMessages = messages.filter(
    (message) => !selectedMessages.includes(message),
  ).length;
  return {
    systemPrompt: source.state.systemPrompt,
    messages: await source.convertToLlm(selectedMessages),
    tools: source.state.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    compactedMessages,
  };
}

/**
 * Serialize the captured raw or observationally compacted executor context.
 * When the advisor's hard model window still cannot fit it, remove only the
 * oldest complete messages; tool definitions, the resolved system prompt, and
 * retained message structures remain intact. Image bytes travel as matching
 * multimodal attachments.
 */
export function buildAdvisorContext(input: BuildAdvisorContextInput): AdvisorContext {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens);
  const reservedOutputTokens = Math.min(
    positiveInteger(input.reservedOutputTokens),
    Math.max(0, contextWindowTokens - 1),
  );
  const safetyMarginTokens = Math.floor(contextWindowTokens * 0.02);
  const advisorSystemTokens = estimateContextTokens(ADVISOR_SYSTEM_PROMPT);
  const inputLimitTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens - safetyMarginTokens - advisorSystemTokens,
  );
  let messages = [...input.context.messages];
  let serialized = serializeContext(
    input.context.systemPrompt,
    input.context.tools,
    messages,
    input.context.compactedMessages ?? 0,
    0,
  );
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
      input.context.compactedMessages ?? 0,
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
      safetyMarginTokens,
      inputLimitTokens,
      inputTargetTokens: Math.min(ADVISOR_INPUT_TARGET_TOKENS, inputLimitTokens),
      estimatedInputTokens: advisorSystemTokens + estimateSerializedTokens(serialized),
      includedMessages: messages.length,
      compactedMessages: input.context.compactedMessages ?? 0,
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
  compactedMessages: number,
  omittedMessages: number,
): { text: string; images: ImageContent[] } {
  const context = {
    systemPrompt,
    tools: [...tools],
    messages: messages.map(projectAdvisorWireMessage),
  };
  const images: ImageContent[] = [];
  const payload = {
    compaction: { compactedMessages },
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

/**
 * Project the executor's provider-neutral message into the fields that become
 * model-visible request content. Pi keeps timestamps, provider identity,
 * diagnostics, token accounting, and opaque replay signatures on messages so
 * the runtime can resume and account for them; those fields are not transcript
 * evidence and a different advisor model cannot replay the signatures. Visible
 * reasoning, tool calls, complete tool-result content, and error state remain.
 */
function projectAdvisorWireMessage(message: Message): unknown {
  if (message.role === "user") {
    return {
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map(projectAdvisorWireContent),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map(projectAdvisorWireContent),
      isError: message.isError,
    };
  }
  return {
    role: message.role,
    content: message.content.flatMap<unknown>((block) => {
      if (block.type === "text") return [{ type: block.type, text: block.text }];
      if (block.type === "thinking") {
        if (block.redacted || block.thinking.trim().length === 0) return [];
        return [{ type: block.type, thinking: block.thinking }];
      }
      return [
        {
          type: block.type,
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        },
      ];
    }),
  };
}

function projectAdvisorWireContent(content: {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}): unknown {
  return content.type === "text"
    ? { type: content.type, text: content.text }
    : { type: content.type, data: content.data, mimeType: content.mimeType };
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
  return (
    estimateContextTokens(serialized.text) + serialized.images.length * IMAGE_WIRE_TOKEN_ESTIMATE
  );
}

/**
 * Keep the existing text estimate for ordinary ASCII while charging multibyte
 * text by UTF-8 size so CJK-heavy transcripts do not look artificially cheap.
 */
function estimateContextTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}
