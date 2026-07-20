import type { ImageContent, ThinkingLevel } from "@earendil-works/pi-ai";
import { generateText, type LanguageModelUsage, type UserContent } from "ai";
import { createDuetModelGateway } from "../model-resolution/model-gateway.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompts.js";

/** Anthropic's advisor guide recommends 2,048 as the starting output cap for compact guidance. */
export const ADVISOR_MAX_OUTPUT_TOKENS = 2_048;

/** Inputs for one advisor generation after catalog shorthand resolution. */
export interface CallAdvisorInput {
  /** Wire-faithful executor context sent as quoted advisor-call content. */
  contextText: string;
  /** Executor images forwarded as real multimodal inputs in transcript order. */
  images: readonly ImageContent[];
  /** Gateway-native `provider/model` id, already resolved by the composition site. */
  modelName: string;
  /** Portable reasoning effort forwarded through AI SDK 7's top-level option. */
  thinkingLevel: ThinkingLevel;
  /** Cancels the advisor request with the parent tool execution. */
  signal?: AbortSignal;
}

/** Compact text returned to the executor after an advisor consultation. */
export interface AdvisorResult {
  /** Compact strategic guidance returned to the executor tool. */
  advice: string;
  /** Provider-reported token usage for pricing and live turn attribution. */
  usage: LanguageModelUsage;
}

/**
 * Run a plain text advisor call through the shared gateway constructor. No
 * provider options are supplied, so this path opts into neither prompt
 * caching nor any provider-specific request behavior.
 */
export async function callAdvisor(input: CallAdvisorInput): Promise<AdvisorResult> {
  const gateway = createDuetModelGateway();

  const content: UserContent = [
    { type: "text", text: input.contextText },
    ...input.images.map((image) => ({
      type: "image" as const,
      image: image.data,
      mediaType: image.mimeType,
    })),
  ];
  const result = await generateText({
    model: gateway(input.modelName),
    system: ADVISOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
    reasoning: input.thinkingLevel,
    abortSignal: input.signal,
  });
  return { advice: result.text, usage: result.usage };
}
