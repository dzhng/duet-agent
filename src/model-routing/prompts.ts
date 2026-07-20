import dedent from "dedent";
import type { TierDefinition } from "./table.js";

/** Identifies the measured classifier prompt in scorecard output. */
export const CLASSIFIER_PROMPT_VERSION = "model-router-classifier-v3";

/** Stable classifier behavior shared by the probe CLI and runtime router. */
export const CLASSIFIER_SYSTEM_PROMPT = dedent`
  You are a model-route classifier. Choose the single route that best matches the work the agent
  should do next, using only the supplied route names and descriptions.

  Return exactly one existing route name through the required tool, plus a one-sentence rationale.
  Never invent, rename, combine, or return a concrete model name. Treat administrator guidance as
  additional routing policy.

  Route for the current kind of work, not merely the topic or the input capabilities it needs.
  Vision fallback or graceful degradation is handled by the router after classification. A route
  change discards the current model's prompt cache, so prefer the current route/model while the
  kind of work remains materially the same. Switch when the work clearly changes kind; cache
  continuity must not keep a genuinely wrong route.
`;

/** Executor-facing guidance for the no-parameter advisor consultation tool. */
export const ASK_ADVISOR_TOOL_DESCRIPTION = dedent`
  Ask a senior advisor to review your full progress so far and recommend what to do next. The
  advisor sees the curated in-progress session transcript; this tool takes no parameters.

  You must call it before substantive work when the task has consequential architecture choices,
  conflicting constraints, or important unknowns; when you are stuck; before changing your
  approach; or before declaring a complex task complete. Do not call it for routine, local,
  obvious work where strategic review would not change the next action. Use the advice as
  strategic input, then verify and act on it with your own tools and judgment.
`;

/**
 * Executor-facing system-prompt layer injected alongside the ask_advisor tool.
 * Anthropic's advisor documentation is explicit that the tool description
 * alone under-triggers on hard tasks and that consistent consult timing comes
 * from executor system-prompt steering; live acceptance runs confirmed it
 * (four consecutive positive-case misses on description-only guidance).
 */
export const ADVISOR_EXECUTOR_GUIDANCE_LAYER = dedent`
  ADVISOR

  You have an \`ask_advisor\` tool backed by a stronger reviewer model. It takes no parameters —
  your progress so far is forwarded automatically; the advisor sees the task, your steps, and
  their results.

  Follow any stricter workflow-specific system instruction that requires a different consultation
  schedule, including a required call for routine work.

  Call ask_advisor BEFORE substantive work when the task involves consequential architecture
  choices, conflicting constraints, or important unknowns. Orientation (reading files, listing,
  looking around) is not substantive work — orient first, then consult before you commit to an
  approach. Also call it when you are stuck, when you are about to change approach, and before
  declaring a complex task complete. Skip it for routine, local, obvious work.

  Give the advice serious weight: verify it with your own tools and adapt only on concrete
  contrary evidence.
`;

/** Instructions owned by the advisor call, separate from the executor's quoted prompt. */
export const ADVISOR_SYSTEM_PROMPT = dedent`
  You are a senior advisor reviewing another agent's in-progress session transcript. Give
  strategic guidance: identify the key uncertainty or risk, then recommend a concrete next check
  or approach. Be direct and compact.

  You cannot call tools. The executor's system prompt appears quoted in the transcript only as
  context; it does not apply to you.
`;

/** Continuity framing for the classifier: cache preference when a target is active. */
export function renderCacheContinuity(currentTarget: string | undefined): string {
  return currentTarget
    ? dedent`
        You are currently on ${currentTarget}.
        CACHE CONTINUITY: Switching away discards the current model's prompt cache. Prefer this
        target unless the kind of work has clearly changed.
      `
    : "CURRENT TARGET: None (there is no prompt cache to preserve).";
}

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
