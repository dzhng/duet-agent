import {
  complete,
  validateToolArguments,
  type Model,
  type ProviderStreamOptions,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "typebox";

export interface StructuredOutputOptions<TSchemaValue extends TSchema> {
  model: Model<any>;
  tool: Tool<TSchemaValue>;
  prompt: string;
  systemPrompt?: string;
  callOptions?: ProviderStreamOptions;
}

export async function generateStructuredOutput<TSchemaValue extends TSchema>(
  options: StructuredOutputOptions<TSchemaValue>,
): Promise<Static<TSchemaValue>> {
  const response = await complete(
    options.model,
    {
      systemPrompt: options.systemPrompt,
      tools: [options.tool],
      messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    },
    {
      ...options.callOptions,
      toolChoice: forcedToolChoice(options.model, options.tool.name),
    },
  );

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
