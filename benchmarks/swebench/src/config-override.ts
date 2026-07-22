import {
  BUILT_IN_ROUTING_TABLE,
  validateRoutingTable,
  type RoutingTable,
} from "../../../src/model-routing/table.js";
import { routingCatalogAdapter } from "../../../src/model-resolution/resolver.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const SWEBENCH_TIER = "swebench";

/** Model substitutions and advisor treatment for one explicit campaign arm. */
export interface RenderModelsJsonOptions {
  /** Main coding model used for every benchmark prompt. */
  executorModel: "glm-5.2" | "kimi-k3" | "opus-4.8";
  /** Reasoning effort sent to the executor for every turn in this campaign arm. */
  executorThinkingLevel: ThinkingLevel;
  /** Advisor retained in both pure and advised renders so OFF changes only availability. */
  advisorModel: "kimi-k3" | "fable-5";
  /** Model-specific advisor effort retained identically in the paired OFF and ON arms. */
  advisorThinkingLevel: ThinkingLevel;
  /** Exposes or removes the advisor tool without changing its target or policy. */
  advisorEnabled: boolean;
}

export const CAMPAIGN_CONFIGS = {
  "glm-pure": {
    executorModel: "glm-5.2",
    executorThinkingLevel: "xhigh",
    advisorModel: "kimi-k3",
    advisorThinkingLevel: "medium",
    advisorEnabled: false,
  },
  "glm-kimi-advisor": {
    executorModel: "glm-5.2",
    executorThinkingLevel: "xhigh",
    advisorModel: "kimi-k3",
    advisorThinkingLevel: "medium",
    advisorEnabled: true,
  },
  "kimi-pure": {
    executorModel: "kimi-k3",
    executorThinkingLevel: "high",
    advisorModel: "fable-5",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
  "kimi-fable-advisor": {
    executorModel: "kimi-k3",
    executorThinkingLevel: "high",
    advisorModel: "fable-5",
    advisorThinkingLevel: "high",
    advisorEnabled: true,
  },
  "opus-pure": {
    executorModel: "opus-4.8",
    executorThinkingLevel: "xhigh",
    advisorModel: "fable-5",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
} as const satisfies Record<string, RenderModelsJsonOptions>;

export type CampaignConfigName = keyof typeof CAMPAIGN_CONFIGS;

/** Canonical campaign arm order used by generation, scoring, and reporting. */
export const CAMPAIGN_CONFIG_NAMES = Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[];

/**
 * Build the complete project routing table consumed by RPC rollouts.
 *
 * The benchmark owns one general-purpose tier rather than selecting a product
 * tier whose executor could drift. Classifier and advisor policy are copied
 * from the product table; executor, advisor, and the fixed Kimi vision fallback
 * are campaign-owned targets.
 */
export function renderModelsJson(options: RenderModelsJsonOptions): RoutingTable {
  const productRoute = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.economy.routes.implement);
  const productAdvisor = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor);
  const table: RoutingTable = {
    defaultTier: SWEBENCH_TIER,
    tiers: {
      [SWEBENCH_TIER]: {
        routes: {
          general: {
            ...productRoute,
            target: {
              modelName: options.executorModel,
              thinkingLevel: options.executorThinkingLevel,
            },
            // GLM is text-only. Keeping the same image-capable fallback in all
            // committed renders makes it policy, not another experimental variable.
            visionFallbackModelName: "kimi-k3",
          },
        },
        advisor: {
          ...productAdvisor,
          enabled: options.advisorEnabled,
          target: {
            modelName: options.advisorModel,
            thinkingLevel: options.advisorThinkingLevel,
          },
        },
      },
    },
    classifier: structuredClone(BUILT_IN_ROUTING_TABLE.classifier),
  };

  const issues = validateRoutingTable(table, routingCatalogAdapter);
  if (issues.length > 0) {
    throw new Error(
      `Invalid SWE-bench routing table:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
  }
  return table;
}

/** Materialize every explicit routing file in deterministic name order. */
export function renderCampaignConfigs(): Record<CampaignConfigName, RoutingTable> {
  return Object.fromEntries(
    CAMPAIGN_CONFIG_NAMES.map((name) => [name, renderModelsJson(CAMPAIGN_CONFIGS[name])]),
  ) as Record<CampaignConfigName, RoutingTable>;
}

export function serializeModelsJson(table: RoutingTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
