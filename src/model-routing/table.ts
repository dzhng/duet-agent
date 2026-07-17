import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVELS, isThinkingLevel } from "../session/thinking-level.js";

const ThinkingLevelSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  { description: "Reasoning effort applied when the target model runs." },
);

const RouteTargetSchema = Type.Object(
  {
    modelName: Type.String({
      minLength: 1,
      description:
        "Concrete catalog name or virtual tier name. Virtual names re-enter routing with the same route.",
    }),
    thinkingLevel: ThinkingLevelSchema,
  },
  { additionalProperties: false },
);

const RouteRuleSchema = Type.Object(
  {
    description: Type.String({
      minLength: 1,
      description: "Classifier-facing guidance describing when this route should be selected.",
    }),
    target: RouteTargetSchema,
  },
  { additionalProperties: false },
);

const AdvisorPolicySchema = Type.Object(
  {
    enabled: Type.Boolean({
      description: "Whether the advisor tool is available while this tier is selected.",
    }),
    target: RouteTargetSchema,
    minStepsBetween: Type.Integer({
      description: "Minimum assistant-completion steps between ordinary advisor calls.",
    }),
    transcriptTokens: Type.Integer({
      description: "Maximum token budget used to assemble the advisor transcript.",
    }),
  },
  { additionalProperties: false },
);

const TierDefinitionSchema = Type.Object(
  {
    routes: Type.Record(Type.String({ minLength: 1 }), RouteRuleSchema, {
      description:
        "Classifier routes for this tier. Missing routes deliberately fall through to general.",
    }),
    visionRoute: Type.String({
      minLength: 1,
      description:
        "Route used when the selected target cannot accept image input. It must resolve to a vision-capable model.",
    }),
    advisor: AdvisorPolicySchema,
  },
  { additionalProperties: false },
);

const ClassifierConfigSchema = Type.Object(
  {
    target: RouteTargetSchema,
    everySteps: Type.Integer({
      description: "Assistant-completion cadence for intra-turn route classification.",
    }),
    guidance: Type.String({
      description: "Freeform administrator guidance appended to the classifier prompt.",
    }),
  },
  { additionalProperties: false },
);

/** Complete, replaceable configuration for virtual model routing. */
export const RoutingTableSchema = Type.Object(
  {
    defaultTier: Type.String({
      minLength: 1,
      description: "Virtual tier selected when the caller does not provide one.",
    }),
    tiers: Type.Record(Type.String({ minLength: 1 }), TierDefinitionSchema, {
      description: "Virtual model names and their routing policies.",
    }),
    classifier: ClassifierConfigSchema,
  },
  { additionalProperties: false },
);

/** A model plus the reasoning effort the router applies to it. */
export interface RouteTarget {
  /** Concrete catalog name, or another virtual tier name for recursive routing. */
  modelName: string;
  /** Reasoning effort that applies once this target resolves to a concrete model. */
  thinkingLevel: ThinkingLevel;
}

/** Classifier-facing route metadata and the target selected by that route. */
export interface RouteRule {
  /** Explains the route's operational intent to the classifier. */
  description: string;
  /** Model and effort selected when the classifier chooses this route. */
  target: RouteTarget;
}

/** Per-tier policy for exposing and rate-limiting the advisor. */
export interface AdvisorPolicy {
  /** Controls whether the tier exposes the advisor tool. */
  enabled: boolean;
  /** Model and effort used for advisor calls. */
  target: RouteTarget;
  /** Minimum completed assistant steps between ordinary advisor calls. */
  minStepsBetween: number;
  /** Token budget for the curated advisor transcript; validation caps it at 20,000. */
  transcriptTokens: number;
}

/** Routes and policies owned by one virtual model tier. */
export interface TierDefinition {
  /** Named classifier routes; an absent requested route falls through to `general`. */
  routes: Record<string, RouteRule>;
  /** Route used by the image-input guard when the initially selected target is text-only. */
  visionRoute: string;
  /** Advisor availability, target, cadence, and transcript budget for this tier. */
  advisor: AdvisorPolicy;
}

/** Shared classifier model, cadence, and administrator-authored routing guidance. */
export interface ClassifierConfig {
  /** Cheap model and effort used for route classification. */
  target: RouteTarget;
  /** Number of completed assistant steps between intra-turn classifications. */
  everySteps: number;
  /** Freeform prompt guidance appended after the generated route descriptions. */
  guidance: string;
}

/** Complete routing configuration. A file override replaces this object as a whole. */
export interface RoutingTable {
  /** Tier used during boot before a caller or classifier selects another tier. */
  defaultTier: string;
  /** Virtual names mapped to their route and advisor definitions. */
  tiers: Record<string, TierDefinition>;
  /** Configuration for the shared route classifier. */
  classifier: ClassifierConfig;
}

/** Catalog capabilities injected by the future composition site. */
export interface RoutingCatalogAdapter {
  /** True for every concrete shorthand or alias accepted by model resolution. */
  isCatalogName(name: string): boolean;
  /** True when the concrete model accepts image inputs. */
  modelAcceptsImages(name: string): boolean;
}

/** Stable validation diagnostic returned without throwing. */
export interface RoutingTableIssue {
  /** Machine-readable category for callers that want to group diagnostics. */
  code:
    | "catalog_collision"
    | "dangling_reference"
    | "virtual_cycle"
    | "invalid_effort"
    | "invalid_cadence"
    | "invalid_transcript_budget"
    | "invalid_vision_fallback";
  /** Dot-delimited location of the invalid value in the table. */
  path: string;
  /** Human-readable explanation, including the full path for virtual cycles. */
  message: string;
}

const VISUAL_DESCRIPTION =
  "Frontend, 3D, or anything visual: UI implementation and debugging, styling, graphics, image inspection, and work where visual fidelity matters.";
const FRONTIER_PLAN_DESCRIPTION =
  "Architecture, investigation, research, and high-stakes planning where the primary work is reasoning about what to build or do, not implementing it.";
const IMPLEMENT_DESCRIPTION =
  "Backend, systems, data, CLI, and other non-visual implementation or debugging work, including tests and code changes.";
const WRITING_DESCRIPTION =
  "Creative writing and prose where voice, narrative, or wording is the primary output rather than analysis or software work.";
const GENERAL_DESCRIPTION =
  "General questions, explanations, summaries, and requests that do not fit a more specific route.";

/** Built-in routing policy fixed by the model-router planning record. */
export const BUILT_IN_ROUTING_TABLE: RoutingTable = {
  defaultTier: "frontier",
  tiers: {
    frontier: {
      routes: {
        visual: {
          description: VISUAL_DESCRIPTION,
          target: { modelName: "kimi-k3", thinkingLevel: "high" },
        },
        plan: {
          description: FRONTIER_PLAN_DESCRIPTION,
          target: { modelName: "fable-5", thinkingLevel: "high" },
        },
        implement: {
          description: IMPLEMENT_DESCRIPTION,
          target: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
        },
        writing: {
          description: WRITING_DESCRIPTION,
          target: { modelName: "opus-4.8", thinkingLevel: "medium" },
        },
        general: {
          description: GENERAL_DESCRIPTION,
          target: { modelName: "gpt-5.6-sol", thinkingLevel: "medium" },
        },
      },
      visionRoute: "visual",
      advisor: {
        enabled: true,
        target: { modelName: "fable-5", thinkingLevel: "high" },
        minStepsBetween: 5,
        transcriptTokens: 10_000,
      },
    },
    balanced: {
      routes: {
        visual: {
          description: VISUAL_DESCRIPTION,
          target: { modelName: "kimi-k3", thinkingLevel: "high" },
        },
        plan: {
          description: FRONTIER_PLAN_DESCRIPTION,
          target: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
        },
        implement: {
          description: IMPLEMENT_DESCRIPTION,
          target: { modelName: "gpt-5.6-terra", thinkingLevel: "high" },
        },
        writing: {
          description: WRITING_DESCRIPTION,
          target: { modelName: "sonnet-5", thinkingLevel: "medium" },
        },
        general: {
          description: GENERAL_DESCRIPTION,
          target: { modelName: "gpt-5.6-terra", thinkingLevel: "medium" },
        },
      },
      visionRoute: "visual",
      advisor: {
        enabled: true,
        target: { modelName: "fable-5", thinkingLevel: "high" },
        minStepsBetween: 5,
        transcriptTokens: 10_000,
      },
    },
    economy: {
      routes: {
        plan: {
          description:
            "Architecture, investigation, research, and planning where the primary work is reasoning about what to build or do, not implementing it.",
          target: { modelName: "gpt-5.6-luna", thinkingLevel: "medium" },
        },
        implement: {
          description:
            "Text-only backend, systems, data, CLI, and other non-visual implementation or debugging work, including tests and code changes.",
          target: { modelName: "glm-5.2", thinkingLevel: "medium" },
        },
        "implement-visual": {
          description:
            "Frontend, UI, styling, graphics, or other implementation and debugging work that requires image input or visual fidelity.",
          target: { modelName: "gpt-5.6-luna", thinkingLevel: "medium" },
        },
        general: {
          description:
            "General questions, explanations, summaries, and creative writing without a more specific route.",
          target: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
        },
      },
      visionRoute: "implement-visual",
      advisor: {
        enabled: false,
        target: { modelName: "gpt-5.6-terra", thinkingLevel: "medium" },
        minStepsBetween: 5,
        transcriptTokens: 10_000,
      },
    },
  },
  classifier: {
    target: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
    everySteps: 5,
    guidance:
      "Prefer continuity when the task has not materially changed, but switch routes when the work changes domains.",
  },
};

/** True when `name` is owned by this routing table rather than the concrete catalog. */
export function isVirtualModel(name: string, table: RoutingTable): boolean {
  return Object.hasOwn(table.tiers, name);
}

/** Virtual model names in deterministic table insertion order. */
export function virtualModelNames(table: RoutingTable): string[] {
  return Object.keys(table.tiers);
}

interface TargetEntry {
  path: string;
  target: RouteTarget;
  virtualAllowed: boolean;
  route?: string;
  tier?: string;
}

function targetEntries(table: RoutingTable): TargetEntry[] {
  const entries: TargetEntry[] = [];
  for (const [tier, definition] of Object.entries(table.tiers)) {
    for (const [route, rule] of Object.entries(definition.routes)) {
      entries.push({
        path: `tiers.${tier}.routes.${route}.target`,
        target: rule.target,
        virtualAllowed: true,
        route,
        tier,
      });
    }
    entries.push({
      path: `tiers.${tier}.advisor.target`,
      target: definition.advisor.target,
      virtualAllowed: false,
    });
  }
  entries.push({
    path: "classifier.target",
    target: table.classifier.target,
    virtualAllowed: false,
  });
  return entries;
}

function routeForTier(
  table: RoutingTable,
  tier: string,
  requestedRoute: string,
): RouteTarget | undefined {
  const definition = table.tiers[tier];
  if (!definition) return undefined;
  const selectedRoute = Object.hasOwn(definition.routes, requestedRoute)
    ? requestedRoute
    : "general";
  const rule = definition.routes[selectedRoute];
  return rule?.target;
}

function virtualPath(
  table: RoutingTable,
  startTier: string,
  route: string,
): { cycle?: string[]; target?: RouteTarget } {
  const chain: string[] = [];
  let tier = startTier;
  while (true) {
    const repeatedAt = chain.indexOf(tier);
    if (repeatedAt !== -1) return { cycle: [...chain.slice(repeatedAt), tier] };
    chain.push(tier);
    const selected = routeForTier(table, tier, route);
    if (!selected) return {};
    if (!isVirtualModel(selected.modelName, table)) return { target: selected };
    tier = selected.modelName;
  }
}

/** Validate cross-field routing invariants against an injected concrete-model catalog. */
export function validateRoutingTable(
  table: RoutingTable,
  catalogAdapter: RoutingCatalogAdapter,
): RoutingTableIssue[] {
  const issues: RoutingTableIssue[] = [];

  for (const tier of virtualModelNames(table)) {
    if (catalogAdapter.isCatalogName(tier)) {
      issues.push({
        code: "catalog_collision",
        path: `tiers.${tier}`,
        message: `Virtual model "${tier}" collides with a concrete catalog shorthand or alias.`,
      });
    }
  }

  if (!isVirtualModel(table.defaultTier, table)) {
    issues.push({
      code: "dangling_reference",
      path: "defaultTier",
      message: `Default tier "${table.defaultTier}" does not name a virtual model.`,
    });
  }

  for (const [tier, definition] of Object.entries(table.tiers)) {
    if (!definition.routes.general) {
      issues.push({
        code: "dangling_reference",
        path: `tiers.${tier}.routes.general`,
        message: `Tier "${tier}" must define the general fallback route.`,
      });
    }
    if (!definition.routes[definition.visionRoute]) {
      issues.push({
        code: "dangling_reference",
        path: `tiers.${tier}.visionRoute`,
        message: `Vision route "${definition.visionRoute}" does not exist in tier "${tier}".`,
      });
    }
    if (definition.advisor.minStepsBetween <= 0) {
      issues.push({
        code: "invalid_cadence",
        path: `tiers.${tier}.advisor.minStepsBetween`,
        message: "Advisor cadence must be a positive number of steps.",
      });
    }
    if (definition.advisor.transcriptTokens <= 0 || definition.advisor.transcriptTokens > 20_000) {
      issues.push({
        code: "invalid_transcript_budget",
        path: `tiers.${tier}.advisor.transcriptTokens`,
        message: "Advisor transcript budget must be between 1 and 20,000 tokens.",
      });
    }
  }

  if (table.classifier.everySteps <= 0) {
    issues.push({
      code: "invalid_cadence",
      path: "classifier.everySteps",
      message: "Classifier cadence must be a positive number of steps.",
    });
  }

  for (const entry of targetEntries(table)) {
    if (!isThinkingLevel(entry.target.thinkingLevel)) {
      issues.push({
        code: "invalid_effort",
        path: `${entry.path}.thinkingLevel`,
        message: `Unknown thinking level "${String(entry.target.thinkingLevel)}".`,
      });
    }
    const targetIsVirtual = isVirtualModel(entry.target.modelName, table);
    if (
      (!entry.virtualAllowed && targetIsVirtual) ||
      (!targetIsVirtual && !catalogAdapter.isCatalogName(entry.target.modelName))
    ) {
      issues.push({
        code: "dangling_reference",
        path: `${entry.path}.modelName`,
        message:
          !entry.virtualAllowed && targetIsVirtual
            ? `Target "${entry.target.modelName}" must name a concrete catalog model.`
            : `Target "${entry.target.modelName}" is neither a virtual model nor a catalog name.`,
      });
    }
    if (entry.tier && entry.route && targetIsVirtual) {
      const result = virtualPath(table, entry.tier, entry.route);
      if (result.cycle) {
        issues.push({
          code: "virtual_cycle",
          path: entry.path,
          message: `Virtual model cycle: ${result.cycle.join(" -> ")}.`,
        });
      }
    }
  }

  for (const [tier, definition] of Object.entries(table.tiers)) {
    if (!definition.routes[definition.visionRoute]) continue;
    const result = virtualPath(table, tier, definition.visionRoute);
    if (result.cycle || !result.target) continue;
    if (
      catalogAdapter.isCatalogName(result.target.modelName) &&
      !catalogAdapter.modelAcceptsImages(result.target.modelName)
    ) {
      issues.push({
        code: "invalid_vision_fallback",
        path: `tiers.${tier}.visionRoute`,
        message: `Vision route "${definition.visionRoute}" resolves to text-only model "${result.target.modelName}".`,
      });
    }
  }

  return issues;
}
