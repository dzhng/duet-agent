import type { Usage } from "@earendil-works/pi-ai";
import {
  experimental_evaluate,
  type Experimental_EvaluationModel,
  type Experimental_EvaluationResult,
} from "ai";
import dedent from "dedent";
import { Type } from "typebox";
import * as structuredOutput from "../core/structured-output.js";
import type { TransportName } from "../model-resolution/catalog.js";
import {
  AI_GATEWAY_API_KEY_ENV,
  createDuetModelGateway,
  DUET_API_KEY_ENV,
  modelGatewayTransport,
} from "../model-resolution/model-gateway.js";
import { resolveMeteredModelName, routingCatalogAdapter } from "../model-resolution/resolver.js";
import { usageFromGatewayReport } from "../turn-runner/usage-accounting.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  renderCacheContinuity,
  renderClassifierInstructions,
  renderClassifierRules,
  type ClassifierPath,
} from "./prompts.js";
import type { ClassifierTarget, TierDefinition } from "./table.js";

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

/**
 * The runtime milestone that requested a classification. Owned here — where
 * the concept originates — and consumed by the router, the protocol event,
 * and the CLI probe, so the union can never drift across layers.
 */
export type RouteTrigger = "turn_start" | "cadence" | "advisor" | "step_trigger" | "compaction";

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
  /** Whether the pending input includes images; the router handles capability after classification. */
  hasImages: boolean;
  /** Event that requested classification, for interpreting sparse cadence/advisor context. */
  trigger: RouteTrigger;
}

/** Pure system/user prompt pair consumed by the structured-output classifier call. */
export interface ClassifierMessages {
  /** Stable classifier policy. */
  systemPrompt: string;
  /** Tier rules plus the lean, request-specific routing facts. */
  prompt: string;
}

/**
 * Classification context the evaluation model judges. Null marks a hint the
 * caller did not supply, so the model never reads a placeholder as content.
 */
export type ClassifierState = {
  trigger: RouteTrigger;
  tier: string;
  imagesPresent: boolean;
  currentTarget: string | null;
  previousTurnHint: string | null;
  currentRequestOrLastStepDelta: string | null;
};

/** The single choice question: one option per route in the classified tier. */
export type ClassifierQuestions = {
  route: {
    type: "choice";
    /** Route policy, administrator guidance, and cache-continuity framing. */
    instructions: string;
    /** Route name mapped to its administrator-authored description. */
    criteria: Record<string, string>;
  };
};

/** Pure evaluation request consumed by the evaluation-model classifier call. */
export interface ClassifierRequest {
  state: ClassifierState;
  questions: ClassifierQuestions;
}

/** Evaluation call seam; production binds the AI SDK's `experimental_evaluate`. */
export type ClassifierEvaluate = (
  call: ClassifierRequest & { model: Experimental_EvaluationModel; abortSignal?: AbortSignal },
) => Promise<
  Pick<Experimental_EvaluationResult<ClassifierQuestions>, "answers" | "usage" | "providerMetadata">
>;

/** Structured-output call seam; production binds `generateStructuredOutput`. */
export type ClassifierGenerate = typeof structuredOutput.generateStructuredOutput;

/** One attributed classifier call, shaped the same whichever path ran it. */
export interface ClassifierUsageReport {
  /** Provider-specific model id the call billed under. */
  modelId: string;
  /** Backend that carried the call. */
  transport: TransportName;
  /** Priced usage; the evaluation path prices from the gateway's reported cost. */
  usage: Usage;
}

/** Options for one live route decision, whichever classifier path the target selects. */
export interface ClassifyRouteOptions {
  /** Classifier target from the routing table; its name selects the path. */
  target: ClassifierTarget;
  /** Cancels the provider request when its owning turn is interrupted. */
  signal?: AbortSignal;
  /** Receives the attributed usage for this call. */
  onUsage?: (report: ClassifierUsageReport) => void;
  /** Evaluation-path network seam for deterministic tests. */
  evaluate?: ClassifierEvaluate;
  /** Chat-path network seam for deterministic tests. */
  generate?: ClassifierGenerate;
}

/** A classifier choice that still names policy, not a concrete execution target. */
export interface ClassifierDecision {
  /** Existing route name selected from the supplied tier. */
  route: string;
  /** One-sentence explanation, returned only by the chat classifier. */
  rationale?: string;
  /** Probability per route, returned only by an evaluation model that reports a distribution. */
  probabilities?: Record<string, number>;
}

/**
 * Which path a classifier target selects, and the single owner of that
 * decision: a name the concrete catalog knows runs the chat classifier,
 * anything else is an AI Gateway evaluation-model id.
 */
export function classifierPath(target: ClassifierTarget): ClassifierPath {
  return routingCatalogAdapter.isCatalogName(target.modelName) ? "chat" : "evaluation";
}

function boundedText(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim();
  return normalized.length <= CONTEXT_HINT_LIMIT
    ? normalized
    : `${normalized.slice(0, CONTEXT_HINT_LIMIT)}…`;
}

function boundedHint(value: string | undefined): string {
  return boundedText(value) ?? "Not provided.";
}

/** Build the complete lean chat-classifier prompts without reading runtime state. */
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

/** Build the complete lean evaluation request without reading runtime state. */
export function buildClassifierRequest(input: ClassifierInput): ClassifierRequest {
  return {
    state: {
      trigger: input.trigger,
      tier: input.tierName,
      imagesPresent: input.hasImages,
      currentTarget: input.currentTarget ?? null,
      previousTurnHint: boundedText(input.prevTurnHint),
      currentRequestOrLastStepDelta: boundedText(input.lastStepDelta),
    },
    questions: {
      route: {
        type: "choice",
        instructions: renderClassifierInstructions(input.guidance, input.currentTarget),
        criteria: Object.fromEntries(
          Object.entries(input.tier.routes).map(([name, rule]) => [name, rule.description]),
        ),
      },
    },
  };
}

function gatewayCostUsd(
  providerMetadata: Experimental_EvaluationResult<ClassifierQuestions>["providerMetadata"],
): number | undefined {
  const cost = providerMetadata?.gateway?.cost;
  const value = typeof cost === "string" || typeof cost === "number" ? Number(cost) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Route choice from a chat model, forced through the `select_route` tool. */
async function classifyWithChatModel(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const model = resolveMeteredModelName(options.target.modelName);
  const messages = buildClassifierMessages(input);
  const generate = options.generate ?? structuredOutput.generateStructuredOutput;
  return await generate({
    model: `${model.provider}:${model.id}`,
    tool: classifierResultTool(Object.keys(input.tier.routes)),
    systemPrompt: messages.systemPrompt,
    prompt: messages.prompt,
    ...(options.target.thinkingLevel
      ? { callOptions: { reasoningEffort: options.target.thinkingLevel } }
      : {}),
    signal: options.signal,
    onUsage: (usage) =>
      options.onUsage?.({
        modelId: model.id,
        transport: model.provider as TransportName,
        usage,
      }),
  });
}

/** Route choice from an AI Gateway evaluation model, with its probability distribution. */
async function classifyWithEvaluationModel(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const transport = modelGatewayTransport();
  if (!transport) {
    throw new Error(
      `Route classification on evaluation model "${options.target.modelName}" needs an AI Gateway credential: set ${DUET_API_KEY_ENV} or ${AI_GATEWAY_API_KEY_ENV}.`,
    );
  }
  const evaluate = options.evaluate ?? experimental_evaluate;
  const result = await evaluate({
    model: createDuetModelGateway().evaluationModel(options.target.modelName),
    ...buildClassifierRequest(input),
    abortSignal: options.signal,
  });
  const costUsd = gatewayCostUsd(result.providerMetadata);
  options.onUsage?.({
    modelId: options.target.modelName,
    transport,
    usage: usageFromGatewayReport({
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      ...(costUsd === undefined ? {} : { costUsd }),
    }),
  });
  const { choice, probabilities } = result.answers.route;
  return { route: choice, ...(probabilities ? { probabilities } : {}) };
}

/** Classify one tier in one model call and reject any route outside that tier. */
export async function classifyRoute(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const decision =
    classifierPath(options.target) === "chat"
      ? await classifyWithChatModel(input, options)
      : await classifyWithEvaluationModel(input, options);
  if (!Object.hasOwn(input.tier.routes, decision.route)) {
    throw new Error(
      `Classifier selected unknown route "${decision.route}" for tier "${input.tierName}".`,
    );
  }
  return decision;
}
