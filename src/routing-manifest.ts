import { walkVirtualRoute } from "./model-routing/resolve.js";
import { DUET_MODEL_TIERS, type DuetModelTier } from "./model-routing/active-tier.js";
import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type RoutingTable,
} from "./model-routing/table.js";
import { DEFAULT_CLI_MEMORY_MODEL, transportModelId } from "./model-resolution/catalog.js";
import { DEFAULT_DUET_EMBEDDING_MODEL } from "./model-resolution/internal-models.js";

export { DUET_MODEL_TIERS, type DuetModelTier } from "./model-routing/active-tier.js";

/** Machine-readable tier-to-gateway-model closure used by product drift checks. */
export type DuetGatewayTierClosures = Readonly<Record<DuetModelTier, readonly string[]>>;

function gatewayModelId(modelName: string): string {
  const modelId = transportModelId("duet-gateway", modelName);
  if (!modelId) {
    throw new Error(`Routing target "${modelName}" has no duet-gateway model id.`);
  }
  return modelId;
}

function concreteRouteTarget(table: RoutingTable, tier: string, route: string): string {
  const walked = walkVirtualRoute(table, tier, route);
  if (walked.cycle) {
    throw new Error(`Virtual model cycle: ${walked.cycle.join(" -> ")}.`);
  }
  if (!walked.target) {
    throw new Error(`Tier "${tier}" has no concrete target for route "${route}".`);
  }
  return walked.target.modelName;
}

/**
 * Project the callable duet-gateway model ids for each built-in tier.
 *
 * Route targets and configured vision fallbacks are followed through virtual
 * references. Advisors contribute only when enabled. The shared classifier,
 * observational-memory actor, and embedding model belong to every tier.
 */
export function projectDuetGatewayTierClosures(table: RoutingTable): DuetGatewayTierClosures {
  const closures = Object.fromEntries(
    DUET_MODEL_TIERS.map((tier) => {
      const definition = table.tiers[tier];
      if (!definition) {
        throw new Error(`Routing table is missing built-in tier "${tier}".`);
      }

      const modelIds = new Set<string>();
      for (const [route, rule] of Object.entries(definition.routes)) {
        modelIds.add(gatewayModelId(concreteRouteTarget(table, tier, route)));
        if (rule.visionFallbackModelName) {
          const fallback = isVirtualModel(rule.visionFallbackModelName, table)
            ? concreteRouteTarget(table, rule.visionFallbackModelName, route)
            : rule.visionFallbackModelName;
          modelIds.add(gatewayModelId(fallback));
        }
      }
      if (definition.advisor.enabled) {
        modelIds.add(gatewayModelId(definition.advisor.target.modelName));
      }
      modelIds.add(gatewayModelId(table.classifier.target.modelName));
      modelIds.add(gatewayModelId(DEFAULT_CLI_MEMORY_MODEL));
      modelIds.add(DEFAULT_DUET_EMBEDDING_MODEL);
      return [tier, Object.freeze([...modelIds])] as const;
    }),
  );
  return Object.freeze(closures) as DuetGatewayTierClosures;
}

/** Built-in billing closures projected from the router's own source table. */
export const BUILT_IN_DUET_GATEWAY_TIER_CLOSURES =
  projectDuetGatewayTierClosures(BUILT_IN_ROUTING_TABLE);
