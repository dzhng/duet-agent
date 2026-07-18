import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { RoutingTable } from "./table.js";

/** Request facts that can change an otherwise deterministic route selection. */
export interface RouteContext {
  /** Whether the pending model input contains one or more images. */
  hasImages: boolean;
}

/** Concrete-model capability needed by the pure resolution kernel. */
export interface RouteResolutionCatalog {
  /** True when the named concrete model accepts image input. */
  modelAcceptsImages(name: string): boolean;
}

/** Final concrete target plus the virtual path that selected it. */
export interface ResolvedTarget {
  /** Virtual tier that owns the final concrete route. */
  tier: string;
  /** Actual route used in the final tier, including general fallthrough. */
  route: string;
  /** Concrete catalog name selected for execution. */
  modelName: string;
  /** Reasoning effort selected by the final route. */
  thinkingLevel: ThinkingLevel;
  /** True when the selected route's image fallback model was applied. */
  visionFallback: boolean;
  /** Ordered virtual tier names visited during recursive resolution. */
  chain: string[];
}

type UncheckedTarget = Omit<ResolvedTarget, "visionFallback">;

/** Non-throwing virtual-chain walk shared by validation and live route resolution. */
export function walkVirtualRoute(
  table: RoutingTable,
  startTier: string,
  requestedRoute: string,
): { cycle?: string[]; target?: UncheckedTarget; chain: string[] } {
  const chain: string[] = [];
  let tier = startTier;
  while (true) {
    const repeatedAt = chain.indexOf(tier);
    if (repeatedAt !== -1) {
      return { cycle: [...chain.slice(repeatedAt), tier], chain };
    }

    const definition = table.tiers[tier];
    if (!definition) return { chain };
    chain.push(tier);
    const route = Object.hasOwn(definition.routes, requestedRoute) ? requestedRoute : "general";
    const rule = definition.routes[route];
    if (!rule) return { chain };

    if (!Object.hasOwn(table.tiers, rule.target.modelName)) {
      return {
        chain,
        target: {
          tier,
          route,
          modelName: rule.target.modelName,
          thinkingLevel: rule.target.thinkingLevel,
          chain,
        },
      };
    }
    tier = rule.target.modelName;
  }
}

function resolveWithoutVisionGuard(
  table: RoutingTable,
  startTier: string,
  requestedRoute: string,
): UncheckedTarget {
  if (!Object.hasOwn(table.tiers, startTier)) {
    throw new Error(`Unknown virtual model tier "${startTier}".`);
  }
  const result = walkVirtualRoute(table, startTier, requestedRoute);
  if (result.cycle) throw new Error(`Virtual model cycle: ${result.cycle.join(" -> ")}.`);
  if (result.target) return result.target;
  const tier = result.chain.at(-1) ?? startTier;
  throw new Error(
    `Tier "${tier}" has neither requested route "${requestedRoute}" nor a general fallback.`,
  );
}

function joinChains(initial: string[], fallback: string[]): string[] {
  if (initial.at(-1) === fallback[0]) return [...initial, ...fallback.slice(1)];
  return [...initial, ...fallback];
}

/** Resolve a virtual tier and classifier route to one concrete model and effort. */
export function resolveRoute(
  table: RoutingTable,
  tier: string,
  route: string,
  ctx: RouteContext,
  catalog: RouteResolutionCatalog,
): ResolvedTarget {
  const selected = resolveWithoutVisionGuard(table, tier, route);
  if (!ctx.hasImages || catalog.modelAcceptsImages(selected.modelName)) {
    return { ...selected, visionFallback: false };
  }

  const fallbackName = table.tiers[selected.tier].routes[selected.route]?.visionFallbackModelName;
  if (!fallbackName) return { ...selected, visionFallback: false };

  const fallback = Object.hasOwn(table.tiers, fallbackName)
    ? resolveWithoutVisionGuard(table, fallbackName, selected.route)
    : { ...selected, modelName: fallbackName, chain: [] };
  if (!catalog.modelAcceptsImages(fallback.modelName)) {
    throw new Error(
      `Vision fallback "${fallbackName}" for route "${selected.route}" resolves to text-only model "${fallback.modelName}".`,
    );
  }

  return {
    ...fallback,
    thinkingLevel: selected.thinkingLevel,
    visionFallback: true,
    chain: joinChains(selected.chain, fallback.chain),
  };
}

/** Resolve the general boot route for a selected virtual tier before classification. */
export function resolveTierDefault(
  table: RoutingTable,
  tier: string,
  context: RouteContext,
  catalog: RouteResolutionCatalog,
): ResolvedTarget {
  return resolveRoute(table, tier, "general", context, catalog);
}
