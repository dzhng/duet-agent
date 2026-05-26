import {
  complete,
  validateToolArguments,
  type ImageContent,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { resolveModelName } from "../model-resolution/resolver.js";
import { resolveProviderApiKey } from "../model-resolution/duet-gateway.js";

export type StructuredOutputPrompt = string | Array<TextContent | ImageContent>;

export interface StructuredOutputOptions<TSchemaValue extends TSchema> {
  model: string;
  tool: Tool<TSchemaValue>;
  prompt: StructuredOutputPrompt;
  systemPrompt?: string;
  callOptions?: ProviderStreamOptions;
  onUsage?: (usage: Usage) => void;
}

export async function generateStructuredOutput<TSchemaValue extends TSchema>(
  options: StructuredOutputOptions<TSchemaValue>,
): Promise<Static<TSchemaValue>> {
  const model = resolveModelName(options.model);
  // pi-ai's `getEnvApiKey(provider)` does not know the project-local
  // `duet-gateway` provider, so an unpinned `complete()` call here
  // would silently send an empty API key. `resolveProviderApiKey`
  // closes that gap; we still let an explicit `callOptions.apiKey`
  // win so callers can override per-request.
  const resolvedApiKey = options.callOptions?.apiKey ?? resolveProviderApiKey(model.provider);
  const callerOnPayload = options.callOptions?.onPayload;
  const response = await complete(
    model,
    {
      systemPrompt: options.systemPrompt,
      tools: [options.tool],
      messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    },
    {
      ...options.callOptions,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      toolChoice: forcedToolChoice(model, options.tool.name),
      onPayload: async (payload, payloadModel) => {
        const next = callerOnPayload ? await callerOnPayload(payload, payloadModel) : undefined;
        const base = next ?? payload;
        return injectResponsesToolChoice(payloadModel, base, options.tool.name);
      },
    },
  );
  options.onUsage?.(response.usage);

  const toolCall = response.content.find((block) => isNamedToolCall(block, options.tool.name));
  if (!toolCall) {
    const contentTypes = response.content.map((block) => block.type).join(", ") || "empty";
    throw new Error(
      `Model did not call required structured output tool: ${options.tool.name}. Stop reason: ${response.stopReason}. Response content: ${contentTypes}${response.errorMessage ? `. Error: ${response.errorMessage}` : ""}`,
    );
  }

  return validateToolArguments(options.tool, toolCall) as Static<TSchemaValue>;
}

function isNamedToolCall(block: unknown, name: string): block is ToolCall {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "toolCall" &&
    "name" in block &&
    block.name === name &&
    "arguments" in block &&
    typeof block.arguments === "object" &&
    block.arguments !== null
  );
}

function forcedToolChoice(model: Model<any>, toolName: string): Record<string, unknown> {
  if (model.api === "anthropic-messages") {
    return { type: "tool", name: toolName };
  }

  return {
    type: "function",
    function: { name: toolName },
  };
}

/**
 * pi-ai's `openai-responses` provider does not read `options.toolChoice`,
 * so the {@link forcedToolChoice} value never reaches the OpenAI Responses
 * API. Without `tool_choice` the model is free to answer with text, and on
 * large inputs (e.g. the full memory-reflect pool) it does, which surfaces
 * as `Model did not call required structured output tool`.
 *
 * We close the gap through `onPayload`, which lets us mutate the params
 * pi-ai is about to send. The Responses API expects a flat
 * `{ type: "function", name: "<tool>" }` shape (not the Chat Completions
 * nested `{ function: { name } }`), so we inject that directly when the
 * payload looks like the Responses request shape.
 */
function injectResponsesToolChoice(model: Model<any>, payload: unknown, toolName: string): unknown {
  if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") {
    return payload;
  }
  if (payload === null || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    tool_choice: { type: "function", name: toolName },
  };
}
