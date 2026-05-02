import type { Guardrail, GuardrailContext, GuardrailResult } from "../types/guardrails.js";

/**
 * Create a guardrail firewall: run multiple guardrails and fail on first block.
 * This composes pattern + semantic + custom guardrails into a single check.
 */
export function createFirewall(guardrails: Guardrail[]): Guardrail {
  return {
    name: "firewall",
    description: `Composite firewall of ${guardrails.length} guardrails`,
    async evaluate(context: GuardrailContext): Promise<GuardrailResult> {
      const warnings: string[] = [];

      for (const g of guardrails) {
        const result = await g.evaluate(context);
        if (!result.allowed) {
          return {
            allowed: false,
            reason: `[${g.name}] ${result.reason}`,
            suggestion: result.suggestion,
          };
        }
        if (result.reason) {
          warnings.push(`[${g.name}] ${result.reason}`);
        }
      }

      return {
        allowed: true,
        reason: warnings.length > 0 ? warnings.join("; ") : undefined,
      };
    },
  };
}
