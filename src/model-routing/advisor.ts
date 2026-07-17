import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { generateText } from "ai";
import { createDuetModelGateway } from "../cli/model-gateway.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompts.js";

/** Inputs for one advisor generation after catalog shorthand resolution. */
export interface CallAdvisorInput {
  /** Curated executor transcript sent as advisor-call content. */
  transcriptText: string;
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
}

/**
 * Run a plain text advisor call through the shared gateway constructor. No
 * provider options are supplied, so this path opts into neither prompt
 * caching nor any provider-specific request behavior.
 */
export async function callAdvisor(input: CallAdvisorInput): Promise<AdvisorResult> {
  const gateway = createDuetModelGateway();

  const result = await generateText({
    model: gateway(input.modelName),
    system: ADVISOR_SYSTEM_PROMPT,
    prompt: input.transcriptText,
    reasoning: input.thinkingLevel,
    abortSignal: input.signal,
  });
  return { advice: result.text };
}
