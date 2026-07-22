import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { THINKING_LEVELS, isThinkingLevel } from "../session/thinking-level.js";
import { walkVirtualRoute } from "./resolve.js";

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
    visionFallbackModelName: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Concrete catalog name or virtual tier used only when this route resolves to a text-only target with image input. The route's configured effort is preserved.",
      }),
    ),
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
  },
  { additionalProperties: false },
);

const TierDefinitionSchema = Type.Object(
  {
    routes: Type.Record(Type.String({ minLength: 1 }), RouteRuleSchema, {
      description:
        "Classifier routes for this tier. Missing routes deliberately fall through to general.",
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
    stepTriggers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({
              minLength: 1,
              description: "Unique administrator-facing name for this step-output trigger.",
            }),
            keywords: Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              description:
                "Non-empty strings matched case-insensitively against bounded step-output text.",
            }),
          },
          { additionalProperties: false },
        ),
        {
          description: "Optional taste triggers that request classification after matching output.",
        },
      ),
    ),
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
  /**
   * Optional image-capable concrete model or virtual tier used when `target` is text-only.
   * Resolution preserves this route's `thinkingLevel`; omission deliberately degrades in place.
   */
  visionFallbackModelName?: string;
}

/** Per-tier policy for exposing and rate-limiting the advisor. */
export interface AdvisorPolicy {
  /** Controls whether the tier exposes the advisor tool. */
  enabled: boolean;
  /** Model and effort used for advisor calls. */
  target: RouteTarget;
  /** Minimum completed assistant steps between ordinary advisor calls. */
  minStepsBetween: number;
}

/** Routes and policies owned by one virtual model tier. */
export interface TierDefinition {
  /** Named classifier routes; an absent requested route falls through to `general`. */
  routes: Record<string, RouteRule>;
  /** Advisor availability, target, and cadence for this tier. */
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
  /** Optional taste triggers matched against bounded text from each completed assistant step. */
  stepTriggers?: StepTriggerConfig[];
}

/** Administrator-authored step-output trigger; correctness triggers remain built-in code. */
export interface StepTriggerConfig {
  /** Non-empty name unique within `classifier.stepTriggers`. */
  name: string;
  /** Non-empty strings matched as case-insensitive substrings against step output. */
  keywords: string[];
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

/** Concrete catalog capabilities injected by model-resolution composition sites. */
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
    | "invalid_vision_fallback_model"
    | "invalid_step_trigger_name"
    | "duplicate_step_trigger_name"
    | "invalid_step_trigger_keywords";
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
  "Backend, systems, data, CLI, and other implementation or debugging work, including tests and code changes.";
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
          target: { modelName: "kimi", thinkingLevel: "high" },
        },
        plan: {
          description: FRONTIER_PLAN_DESCRIPTION,
          target: { modelName: "fable", thinkingLevel: "high" },
        },
        implement: {
          description: IMPLEMENT_DESCRIPTION,
          target: { modelName: "sol", thinkingLevel: "high" },
        },
        writing: {
          description: WRITING_DESCRIPTION,
          target: { modelName: "opus", thinkingLevel: "medium" },
        },
        general: {
          description: GENERAL_DESCRIPTION,
          target: { modelName: "sol", thinkingLevel: "medium" },
        },
      },
      advisor: {
        enabled: true,
        target: { modelName: "fable", thinkingLevel: "high" },
        minStepsBetween: 5,
      },
    },
    balanced: {
      routes: {
        visual: {
          description: VISUAL_DESCRIPTION,
          target: { modelName: "kimi", thinkingLevel: "high" },
        },
        plan: {
          description: FRONTIER_PLAN_DESCRIPTION,
          target: { modelName: "sol", thinkingLevel: "high" },
        },
        implement: {
          description: IMPLEMENT_DESCRIPTION,
          target: { modelName: "terra", thinkingLevel: "high" },
        },
        writing: {
          description: WRITING_DESCRIPTION,
          target: { modelName: "sonnet", thinkingLevel: "medium" },
        },
        general: {
          description: GENERAL_DESCRIPTION,
          target: { modelName: "terra", thinkingLevel: "medium" },
        },
      },
      advisor: {
        enabled: true,
        target: { modelName: "fable", thinkingLevel: "high" },
        minStepsBetween: 5,
      },
    },
    economy: {
      routes: {
        plan: {
          description:
            "Architecture, investigation, research, and planning where the primary work is reasoning about what to build or do, not implementing it.",
          target: { modelName: "luna", thinkingLevel: "medium" },
        },
        implement: {
          description:
            "Backend, systems, data, CLI, and other implementation or debugging work, including tests and code changes.",
          target: { modelName: "glm", thinkingLevel: "medium" },
          // Recorded product rationale: image-bearing implementation stays on the work-kind route;
          // capability correction belongs to router policy, not classifier taxonomy.
          visionFallbackModelName: "luna",
        },
        general: {
          description:
            "General questions, explanations, summaries, and creative writing without a more specific route.",
          target: { modelName: "luna", thinkingLevel: "low" },
        },
      },
      advisor: {
        enabled: false,
        target: { modelName: "terra", thinkingLevel: "medium" },
        minStepsBetween: 5,
      },
    },
  },
  classifier: {
    target: { modelName: "luna", thinkingLevel: "low" },
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
    if (definition.advisor.minStepsBetween <= 0) {
      issues.push({
        code: "invalid_cadence",
        path: `tiers.${tier}.advisor.minStepsBetween`,
        message: "Advisor cadence must be a positive number of steps.",
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

  const triggerNames = new Set<string>();
  for (const [index, trigger] of (table.classifier.stepTriggers ?? []).entries()) {
    const path = `classifier.stepTriggers.${index}`;
    if (!trigger.name.trim()) {
      issues.push({
        code: "invalid_step_trigger_name",
        path: `${path}.name`,
        message: "Step trigger name must be non-empty.",
      });
    } else if (triggerNames.has(trigger.name)) {
      issues.push({
        code: "duplicate_step_trigger_name",
        path: `${path}.name`,
        message: `Step trigger name "${trigger.name}" must be unique.`,
      });
    }
    triggerNames.add(trigger.name);
    if (trigger.keywords.length === 0 || trigger.keywords.some((keyword) => !keyword.trim())) {
      issues.push({
        code: "invalid_step_trigger_keywords",
        path: `${path}.keywords`,
        message: "Step trigger keywords must be a non-empty array of non-empty strings.",
      });
    }
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
      const result = walkVirtualRoute(table, entry.tier, entry.route);
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
    for (const [route, rule] of Object.entries(definition.routes)) {
      const fallbackName = rule.visionFallbackModelName;
      if (!fallbackName) continue;
      const path = `tiers.${tier}.routes.${route}.visionFallbackModelName`;
      const fallbackIsVirtual = isVirtualModel(fallbackName, table);
      if (!fallbackIsVirtual && !catalogAdapter.isCatalogName(fallbackName)) {
        issues.push({
          code: "invalid_vision_fallback_model",
          path,
          message: `Vision fallback "${fallbackName}" is neither a virtual model nor a catalog name.`,
        });
        continue;
      }
      const result = fallbackIsVirtual
        ? walkVirtualRoute(table, fallbackName, route)
        : { target: { modelName: fallbackName } };
      if ("cycle" in result && result.cycle) {
        issues.push({
          code: "invalid_vision_fallback_model",
          path,
          message: `Vision fallback cycle: ${result.cycle.join(" -> ")}.`,
        });
        continue;
      }
      if (!result.target || !catalogAdapter.modelAcceptsImages(result.target.modelName)) {
        issues.push({
          code: "invalid_vision_fallback_model",
          path,
          message: result.target
            ? `Vision fallback "${fallbackName}" resolves to text-only model "${result.target.modelName}".`
            : `Vision fallback "${fallbackName}" does not resolve for route "${route}".`,
        });
      }
    }
  }

  return issues;
}
