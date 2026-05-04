import type { Model, Tool } from "@mariozechner/pi-ai";
import dedent from "dedent";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
import type { Guardrail, GuardrailContext, GuardrailResult } from "../types/guardrails.js";

const semanticGuardrailResultSchema = Type.Object({
  allowed: Type.Boolean({ description: "Whether the action is allowed under the policy" }),
  reason: Type.String({ description: "Brief explanation for the decision" }),
  suggestion: Type.Optional(
    Type.String({ description: "Safer alternative when the action is blocked" }),
  ),
});

const EVALUATE_GUARDRAIL_TOOL = "evaluateGuardrail";
const semanticGuardrailTool: Tool<typeof semanticGuardrailResultSchema> = {
  name: EVALUATE_GUARDRAIL_TOOL,
  description: "Return the semantic guardrail decision",
  parameters: semanticGuardrailResultSchema,
};

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
    const prompt = dedent`
      You are a security guardrail. Evaluate whether this action should be allowed.

      POLICY:
      ${this.policy}

      ACTION: ${context.action}
      CONTENT: ${context.content}

      Call the ${EVALUATE_GUARDRAIL_TOOL} tool with your decision.
    `;

    return generateStructuredOutput({
      model: this.model,
      tool: semanticGuardrailTool,
      prompt,
    });
  }
}
