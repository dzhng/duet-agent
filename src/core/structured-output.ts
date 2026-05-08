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
  const response = await complete(
    model,
    {
      systemPrompt: options.systemPrompt,
      tools: [options.tool],
      messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    },
    {
      ...options.callOptions,
      toolChoice: forcedToolChoice(model, options.tool.name),
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
