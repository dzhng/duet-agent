import { completeSimple, type Model } from "@mariozechner/pi-ai";
import type { Guardrail, GuardrailContext, GuardrailResult } from "../core/types.js";

/**
 * Semantic guardrail: uses an LLM to evaluate whether an action
 * is safe and appropriate. Expensive but catches nuanced violations.
 */
export class SemanticGuardrail implements Guardrail {
  name = "semantic";
  description = "LLM-evaluated action safety check";

  constructor(
    private readonly model: Model<any>,
    private readonly policy: string,
  ) {}

  async evaluate(context: GuardrailContext): Promise<GuardrailResult> {
    const prompt = `You are a security guardrail. Evaluate whether this action should be allowed.

POLICY:
${this.policy}

ACTION: ${context.action}
CONTENT: ${context.content}
AGENT: ${context.agentId}

Respond with JSON: { "allowed": boolean, "reason": string, "suggestion"?: string }`;

    const response = await completeSimple(this.model, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    try {
      return JSON.parse(text);
    } catch {
      // If parsing fails, be conservative
      return { allowed: false, reason: "Failed to parse guardrail response" };
    }
  }
}
