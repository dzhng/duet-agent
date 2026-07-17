import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { classifyRoute, type ClassifierDecision } from "../model-routing/classifier.js";
import { loadRoutingTable, type LoadedRoutingTable } from "../model-routing/loader.js";
import { resolveRoute } from "../model-routing/resolve.js";
import { isKnownShorthand } from "../model-resolution/catalog.js";
import { resolveProviderApiKey } from "../model-resolution/duet-gateway.js";
import { resolveModelName } from "../model-resolution/resolver.js";
import { loadCliEnvFiles } from "./shared.js";

/** Parsed arguments for the permanent route-classifier workbench. */
export interface RouteArgs {
  /** Virtual tier to inspect; omitted means the table's default tier. */
  model?: string;
  /** Simulates pending image input so the vision guard is exercised. */
  images: boolean;
  /** Emits one machine-readable decision instead of the human report. */
  json: boolean;
  /** Prints command-specific help without making a classifier call. */
  help: boolean;
  /** Work description classified by the live routing model. */
  prompt?: string;
}

/** Stable output shared by human and JSON renderers. */
export interface RouteCommandResult {
  /** Requested or default virtual tier. */
  tier: string;
  /** Classifier-selected route before concrete resolution. */
  route: string;
  /** Final concrete model after virtual and vision fallbacks. */
  model: string;
  /** Reasoning effort attached to the final concrete target. */
  effort: ThinkingLevel;
  /** One-sentence explanation from the classifier. */
  rationale: string;
  /** Virtual tiers traversed while resolving the selected route. */
  resolutionChain: string[];
  /** Built-in marker or path of the active replacement table. */
  tableSource: string;
  /** Wall-clock classifier plus resolution latency. */
  latencyMs: number;
}

/** Narrow test/embedding seam around process-owned route command effects. */
export interface RouteCommandOptions {
  /** Project directory used for env and routing-table discovery. */
  cwd?: string;
  /** Output sink; defaults to stdout. */
  write?: (text: string) => void;
  /** Classifier seam used by deterministic CLI tests. */
  classify?: (
    input: Parameters<typeof classifyRoute>[0],
    options: Parameters<typeof classifyRoute>[1],
  ) => Promise<ClassifierDecision>;
  /** Monotonic-enough clock used to report probe latency. */
  now?: () => number;
}

function printRouteHelp(write: (text: string) => void): void {
  write(
    `duet route — Probe the live virtual-model classifier\n\nUSAGE\n  duet route [--model <tier>] [--images] [--json] "<prompt>"\n`,
  );
}

/** Parse route flags while preserving a natural multi-word positional prompt. */
export function parseRouteArgs(args: string[]): RouteArgs {
  const parsed: RouteArgs = { images: false, json: false, help: false };
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--model" || arg === "-m") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${arg}`);
      parsed.model = value;
    } else if (arg === "--images") {
      parsed.images = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown route option: ${arg}`);
    } else {
      prompt.push(arg);
    }
  }
  if (prompt.length > 0) parsed.prompt = prompt.join(" ");
  return parsed;
}

const ROUTING_CATALOG_ADAPTER = {
  isCatalogName: isKnownShorthand,
  modelAcceptsImages: (name: string) => resolveModelName(name).input.includes("image"),
};

function tableSource(loaded: LoadedRoutingTable): string {
  return loaded.source === "built-in" ? loaded.source : loaded.path;
}

function classifierModelReference(modelName: string): string {
  const model = resolveModelName(modelName);
  if (!resolveProviderApiKey(model.provider)) {
    throw new Error(`No API key configured for classifier provider "${model.provider}".`);
  }
  return `${model.provider}:${model.id}`;
}

function renderHuman(result: RouteCommandResult): string {
  return [
    `Tier: ${result.tier}`,
    `Route: ${result.route}`,
    `Model: ${result.model}`,
    `Effort: ${result.effort}`,
    `Rationale: ${result.rationale}`,
    `Resolution chain: ${result.resolutionChain.join(" -> ")}`,
    `Table source: ${result.tableSource}`,
    `Latency: ${result.latencyMs} ms`,
  ].join("\n");
}

/** Run one live route probe against the effective project routing table. */
export async function runRouteCommand(
  args: string[],
  options: RouteCommandOptions = {},
): Promise<RouteCommandResult | undefined> {
  const parsed = parseRouteArgs(args);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (parsed.help) {
    printRouteHelp(write);
    return undefined;
  }
  if (!parsed.prompt?.trim()) throw new Error("Missing route prompt.");

  const cwd = options.cwd ?? process.cwd();
  loadCliEnvFiles(cwd);
  const loaded = await loadRoutingTable({ cwd, catalogAdapter: ROUTING_CATALOG_ADAPTER });
  const tierName = parsed.model ?? loaded.table.defaultTier;
  const tier = loaded.table.tiers[tierName];
  if (!tier) throw new Error(`Unknown virtual model tier "${tierName}".`);

  const now = options.now ?? Date.now;
  const startedAt = now();
  const decision = await (options.classify ?? classifyRoute)(
    {
      tierName,
      tier,
      guidance: loaded.table.classifier.guidance,
      lastStepDelta: parsed.prompt,
      hasImages: parsed.images,
      trigger: "turn_start",
    },
    { model: classifierModelReference(loaded.table.classifier.target.modelName) },
  );
  const resolved = resolveRoute(
    loaded.table,
    tierName,
    decision.route,
    { hasImages: parsed.images },
    ROUTING_CATALOG_ADAPTER,
  );
  const result: RouteCommandResult = {
    tier: tierName,
    route: decision.route,
    model: resolved.modelName,
    effort: resolved.thinkingLevel,
    rationale: decision.rationale,
    resolutionChain: resolved.chain,
    tableSource: tableSource(loaded),
    latencyMs: Math.max(0, now() - startedAt),
  };
  write(`${parsed.json ? JSON.stringify(result) : renderHuman(result)}\n`);
  return result;
}
