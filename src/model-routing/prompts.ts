import dedent from "dedent";
import type { TierDefinition } from "./table.js";

/** Stable classifier behavior shared by the probe CLI and the future runtime router. */
export const CLASSIFIER_SYSTEM_PROMPT = dedent`
  You are a model-route classifier. Choose the single route that best matches the work the agent
  should do next, using only the supplied route names and descriptions.

  Return exactly one existing route name through the required tool, plus a one-sentence rationale.
  Never invent, rename, combine, or return a concrete model name. Treat administrator guidance as
  additional routing policy.

  Route for the current kind of work, not merely the topic. Images present means the next model
  must be able to inspect image input. A route change discards the current model's prompt cache, so
  prefer the current route/model while the kind of work remains materially the same. Switch when
  the work clearly changes kind; cache continuity must not keep a genuinely wrong route.
`;

/** Render every route in one tier for a single all-entries classifier decision. */
export function renderClassifierRules(
  tierName: string,
  tier: TierDefinition,
  guidance: string,
): string {
  const routes = Object.entries(tier.routes)
    .map(([name, rule]) => `- ${name}: ${rule.description}`)
    .join("\n");
  return dedent`
    TIER: ${tierName}

    AVAILABLE ROUTES:
    ${routes}

    ADMINISTRATOR GUIDANCE:
    ${guidance.trim() || "No additional guidance."}
  `;
}
