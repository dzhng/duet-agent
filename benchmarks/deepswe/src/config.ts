import type { ThinkingLevel } from "@earendil-works/pi-ai";

import {
  BUILT_IN_ROUTING_TABLE,
  validateRoutingTable,
  type RoutingTable,
} from "../../../src/model-routing/table.js";
import { routingCatalogAdapter } from "../../../src/model-resolution/resolver.js";

export const DEEPSWE_TIER = "deepswe";

export const DEEPSWE_ARMS = {
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
    executorModel: "opus-5",
    executorThinkingLevel: "xhigh",
    advisorModel: "fable-5",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
  "fable-pure": {
    executorModel: "fable-5",
    executorThinkingLevel: "high",
    advisorModel: "fable-5",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
} as const satisfies Record<string, DeepSweArm>;

export type DeepSweArmName = keyof typeof DEEPSWE_ARMS;
/** Canonical arm order shared by job generation, completion checks, and reports. */
export const DEEPSWE_ARM_NAMES = Object.keys(DEEPSWE_ARMS) as DeepSweArmName[];

export interface DeepSweArm {
  /** Main coding model used for the complete repository task. */
  executorModel: "fable-5" | "glm-5.2" | "kimi-k3" | "opus-5";
  /** Reasoning effort sent to the executor on every turn. */
  executorThinkingLevel: ThinkingLevel;
  /** Advisor target retained unchanged in both members of a pair. */
  advisorModel: "kimi-k3" | "fable-5";
  /** Advisor effort retained unchanged in both members of a pair. */
  advisorThinkingLevel: ThinkingLevel;
  /** The only treatment variable within a pure/advised pair. */
  advisorEnabled: boolean;
}

/**
 * Build a complete benchmark-owned routing table. Only executor and advisor
 * targets differ from the product table; classifier and memory behavior remain
 * the product defaults.
 */
export function renderDeepSweConfig(arm: DeepSweArm): RoutingTable {
  const productRoute = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.economy.routes.implement);
  const productAdvisor = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor);
  const table: RoutingTable = {
    defaultTier: DEEPSWE_TIER,
    tiers: {
      [DEEPSWE_TIER]: {
        routes: {
          general: {
            ...productRoute,
            target: {
              modelName: arm.executorModel,
              thinkingLevel: arm.executorThinkingLevel,
            },
            visionFallbackModelName: "kimi-k3",
          },
        },
        advisor: {
          ...productAdvisor,
          enabled: arm.advisorEnabled,
          target: {
            modelName: arm.advisorModel,
            thinkingLevel: arm.advisorThinkingLevel,
          },
        },
      },
    },
    classifier: structuredClone(BUILT_IN_ROUTING_TABLE.classifier),
  };

  const issues = validateRoutingTable(table, routingCatalogAdapter);
  if (issues.length > 0) {
    throw new Error(
      `Invalid DeepSWE routing table:\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return table;
}

/** Materialize all six arms in their stable experiment order. */
export function renderDeepSweConfigs(): Record<DeepSweArmName, RoutingTable> {
  return Object.fromEntries(
    DEEPSWE_ARM_NAMES.map((name) => [name, renderDeepSweConfig(DEEPSWE_ARMS[name])]),
  ) as Record<DeepSweArmName, RoutingTable>;
}

export function serializeDeepSweConfig(table: RoutingTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
