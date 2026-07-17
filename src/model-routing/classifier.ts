import type { Usage } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { Type } from "typebox";
import * as structuredOutput from "../core/structured-output.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  renderCacheContinuity,
  renderClassifierRules,
} from "./prompts.js";
import type { TierDefinition } from "./table.js";

const CONTEXT_HINT_LIMIT = 1_000;

function classifierResultTool(routeNames: string[]) {
  return {
    name: "select_route",
    description: "Select exactly one existing route for the agent's next work.",
    parameters: Type.Object(
      {
        route: Type.Union(
          routeNames.map((name) => Type.Literal(name)),
          { description: "Exactly one route name from AVAILABLE ROUTES." },
        ),
        rationale: Type.String({
          minLength: 1,
          description: "One sentence explaining why this route matches the current work.",
        }),
      },
      { additionalProperties: false },
    ),
  };
}

/** Lean routing facts supplied at a turn boundary or intra-turn milestone. */
export interface ClassifierInput {
  /** Virtual tier whose complete route set is being classified in one call. */
  tierName: string;
  /** Tier rules shown to the classifier; concrete targets remain hidden. */
  tier: TierDefinition;
  /** Administrator-authored routing and cache-preference policy. */
  guidance: string;
  /** Current concrete target and selecting route, when continuity is possible. */
  currentTarget?: string;
  /** Bounded summary of the preceding turn, used only to judge task continuity. */
  prevTurnHint?: string;
  /** Bounded description of what changed in the most recent agent step. */
  lastStepDelta?: string;
  /** Whether the pending input includes images that the selected route must support. */
  hasImages: boolean;
  /** Event that requested classification, for interpreting sparse cadence/advisor context. */
  trigger: "turn_start" | "cadence" | "advisor";
}

/** Pure system/user prompt pair consumed by the structured-output classifier call. */
export interface ClassifierMessages {
  /** Stable classifier policy. */
  systemPrompt: string;
  /** Tier rules plus the lean, request-specific routing facts. */
  prompt: string;
}

/** Options for the live structured-output route decision. */
export interface ClassifyRouteOptions {
  /** Classifier model reference resolved by the caller's composition layer. */
  model: string;
  /** Cancels the provider request when its owning turn is interrupted. */
  signal?: AbortSignal;
  /** Receives classifier token and cost usage for attribution. */
  onUsage?: (usage: Usage) => void;
}

/** A classifier choice that still names policy, not a concrete execution target. */
export interface ClassifierDecision {
  /** Existing route name selected from the supplied tier. */
  route: string;
  /** One-sentence explanation returned by the classifier. */
  rationale: string;
}

function boundedHint(value: string | undefined): string {
  if (!value?.trim()) return "Not provided.";
  const normalized = value.trim();
  return normalized.length <= CONTEXT_HINT_LIMIT
    ? normalized
    : `${normalized.slice(0, CONTEXT_HINT_LIMIT)}…`;
}

/** Build the complete lean classifier request without reading runtime state. */
export function buildClassifierMessages(input: ClassifierInput): ClassifierMessages {
  const continuity = renderCacheContinuity(input.currentTarget);

  return {
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    prompt: dedent`
      ${renderClassifierRules(input.tierName, input.tier, input.guidance)}

      CLASSIFICATION CONTEXT:
      Trigger: ${input.trigger}
      Images present: ${input.hasImages ? "yes" : "no"}
      ${continuity}
      Previous-turn hint: ${boundedHint(input.prevTurnHint)}
      Current request / last-step delta: ${boundedHint(input.lastStepDelta)}

      Pick exactly one name from AVAILABLE ROUTES and give a one-sentence rationale.
    `,
  };
}

/** Classify one tier in one model call and reject any route outside that tier. */
export async function classifyRoute(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const messages = buildClassifierMessages(input);
  const result = await structuredOutput.generateStructuredOutput({
    model: options.model,
    tool: classifierResultTool(Object.keys(input.tier.routes)),
    systemPrompt: messages.systemPrompt,
    prompt: messages.prompt,
    callOptions: { reasoningEffort: "low" },
    signal: options.signal,
    onUsage: options.onUsage,
  });
  if (!Object.hasOwn(input.tier.routes, result.route)) {
    throw new Error(
      `Classifier selected unknown route "${result.route}" for tier "${input.tierName}".`,
    );
  }
  return result;
}
