import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ensureFreshConnectedTokens } from "../connected-providers/tokens.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAdvisorContext,
  type AdvisorExecutorContext,
} from "../model-routing/advisor-context.js";
import { ADVISOR_MAX_OUTPUT_TOKENS } from "../model-routing/advisor.js";
import { classifyRoute, type ClassifierDecision } from "../model-routing/classifier.js";
import { loadRoutingTable, type LoadedRoutingTable } from "../model-routing/loader.js";
import { resolveRoute } from "../model-routing/resolve.js";
import type { TurnFacts } from "../model-routing/step-triggers.js";
import { isConnectedProviderId } from "../connected-providers/store.js";
import { isProviderPinnedModelName } from "../model-resolution/catalog.js";
import { resolveProviderApiKey } from "../model-resolution/duet-gateway.js";
import {
  pinnedModelReference,
  resolveModelName,
  routingCatalogAdapter,
} from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH, DEFAULT_SESSION_STORAGE_DIR } from "../session/session-manager.js";
import { listRecentSessions } from "../tui/recent-sessions.js";
import { TurnRunner } from "../turn-runner/turn-runner.js";
import type { TurnState } from "../types/protocol.js";
import { loadCliEnvFiles } from "./shared.js";

/** Parsed arguments for the permanent route-classifier workbench. */
export interface RouteArgs {
  /** Virtual tier to inspect; omitted means the table's default tier. */
  model?: string;
  /** Simulates pending image input so the vision guard is exercised. */
  images: boolean;
  /** Emits one machine-readable decision instead of the human report. */
  json: boolean;
  /** Includes the concrete transport decision and plan-coverage provenance. */
  explain?: boolean;
  /** Prints command-specific help without making a classifier call. */
  help: boolean;
  /** Work description classified by the live routing model. */
  prompt?: string;
  /** Selects the stored-session advisor transcript preview instead of classification. */
  advisorPreview?: boolean;
  /** Stored session id for advisor preview; omitted selects the newest session. */
  session?: string;
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
  /** Concrete backend selected for the call when `--explain` is requested. */
  transport?: string;
  /** Provider-specific model id sent on the explained transport. */
  transportModelId?: string;
  /** Whether a connected subscription covers the explained call. */
  planCovered?: boolean;
  /** Selection rule that produced the explained transport. */
  transportReason?: "connected" | "router_order" | "explicit_pin";
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
  /** Session root override used by preview tests and alternate installations. */
  sessionsRoot?: string;
  /** Memory database used to render stored observations; false keeps preview raw. */
  memoryDbPath?: string | false;
}

function printRouteHelp(write: (text: string) => void): void {
  write(
    `duet route — Probe model routing and advisor context\n\nUSAGE\n  duet route [--model <tier>] [--images] [--json] [--explain] "<prompt>"\n  duet route advisor-preview [--session <id>]\n`,
  );
}

/** Parse route flags while preserving a natural multi-word positional prompt. */
export function parseRouteArgs(args: string[]): RouteArgs {
  const parsed: RouteArgs = { images: false, json: false, help: false };
  if (args[0] === "advisor-preview") {
    parsed.advisorPreview = true;
    for (let index = 1; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--session") {
        const value = args[++index];
        if (!value || value.startsWith("-")) throw new Error("Missing value for --session");
        parsed.session = value;
      } else if (arg === "--help" || arg === "-h") {
        parsed.help = true;
      } else {
        throw new Error(`Unknown advisor-preview option: ${arg}`);
      }
    }
    return parsed;
  }
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
    } else if (arg === "--explain") {
      parsed.explain = true;
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

/** Stable report returned by the read-only advisor transcript preview. */
export interface AdvisorPreviewResult {
  /** Stored session whose transcript was assembled. */
  sessionId: string;
  /** Routed tier whose advisor model window was applied. */
  tier: string;
  /** Exact structured text content the advisor tool would send. */
  transcript: string;
  /** Heuristic token estimate for the complete advisor request, including images. */
  tokens: number;
  /** Whether the advisor model window forced oldest-message omission. */
  truncated: boolean;
  /** Input-only cost projection for every configured tier's advisor target. */
  estimates: Array<{
    /** Virtual tier owning this advisor policy. */
    tier: string;
    /** Catalog shorthand of the configured advisor target. */
    model: string;
    /** Whether the tier actually exposes the advisor tool. */
    enabled: boolean;
    /** Estimated USD input cost, or undefined when the model has no preview price. */
    inputUsd: number | undefined;
  }>;
}

function tableSource(loaded: LoadedRoutingTable): string {
  return loaded.source === "built-in" ? loaded.source : loaded.path;
}

function classifierModelReference(modelName: string): string {
  const reference = pinnedModelReference(modelName);
  const provider = reference.slice(0, reference.indexOf(":"));
  if (!resolveProviderApiKey(provider)) {
    throw new Error(`No API key configured for classifier provider "${provider}".`);
  }
  return reference;
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
    ...(result.transport
      ? [
          `Transport: ${result.transport} modelId=${result.transportModelId} reason=${result.transportReason} planCovered=${result.planCovered}`,
        ]
      : []),
    `Latency: ${result.latencyMs} ms`,
  ].join("\n");
}

/** Run one live route probe against the effective project routing table. */
export async function runRouteCommand(
  args: string[],
  options: RouteCommandOptions = {},
): Promise<RouteCommandResult | AdvisorPreviewResult | undefined> {
  const parsed = parseRouteArgs(args);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (parsed.help) {
    printRouteHelp(write);
    return undefined;
  }
  if (parsed.advisorPreview) {
    return runAdvisorPreview(parsed, options, write);
  }
  if (!parsed.prompt?.trim()) throw new Error("Missing route prompt.");

  const cwd = options.cwd ?? process.cwd();
  loadCliEnvFiles(cwd);
  const loaded = await loadRoutingTable({ cwd, catalogAdapter: routingCatalogAdapter });
  const tierName = parsed.model ?? loaded.table.defaultTier;
  const tier = loaded.table.tiers[tierName];
  if (!tier) throw new Error(`Unknown virtual model tier "${tierName}".`);

  const now = options.now ?? Date.now;
  const startedAt = now();
  const facts: TurnFacts = { hasImages: parsed.images };
  const decision = await (options.classify ?? classifyRoute)(
    {
      tierName,
      tier,
      guidance: loaded.table.classifier.guidance,
      lastStepDelta: parsed.prompt,
      hasImages: facts.hasImages,
      trigger: "turn_start",
    },
    {
      model: classifierModelReference(loaded.table.classifier.target.modelName),
      thinkingLevel: loaded.table.classifier.target.thinkingLevel,
    },
  );
  const resolved = resolveRoute(
    loaded.table,
    tierName,
    decision.route,
    facts,
    routingCatalogAdapter,
  );
  if (parsed.explain) {
    // A turn awaits this refresh before resolving; --explain must match what
    // the turn would actually select, not the stale pre-refresh cache.
    await ensureFreshConnectedTokens();
  }
  const explainedModel = parsed.explain ? resolveModelName(resolved.modelName) : undefined;
  const planCovered = explainedModel ? isConnectedProviderId(explainedModel.provider) : undefined;
  const result: RouteCommandResult = {
    tier: tierName,
    route: decision.route,
    model: resolved.modelName,
    effort: resolved.thinkingLevel,
    rationale: decision.rationale,
    resolutionChain: resolved.chain,
    tableSource: tableSource(loaded),
    ...(explainedModel
      ? {
          transport: explainedModel.provider,
          transportModelId: explainedModel.id,
          planCovered,
          transportReason: isProviderPinnedModelName(resolved.modelName)
            ? "explicit_pin"
            : planCovered
              ? "connected"
              : "router_order",
        }
      : {}),
    latencyMs: Math.max(0, now() - startedAt),
  };
  write(`${parsed.json ? JSON.stringify(result) : renderHuman(result)}\n`);
  return result;
}

async function runAdvisorPreview(
  parsed: RouteArgs,
  options: RouteCommandOptions,
  write: (text: string) => void,
): Promise<AdvisorPreviewResult> {
  const cwd = options.cwd ?? process.cwd();
  loadCliEnvFiles(cwd);
  const sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSION_STORAGE_DIR;
  const sessionId = parsed.session ?? listRecentSessions({ sessionsRoot, limit: 1 })[0]?.sessionId;
  if (!sessionId) throw new Error("No stored sessions found for advisor preview.");
  if (sanitizeSessionId(sessionId) !== sessionId) {
    throw new Error(`Invalid session id "${sessionId}".`);
  }

  const statePath = join(sessionsRoot, sessionId, "state.json");
  const stored = JSON.parse(await readFile(statePath, "utf8")) as { state?: TurnState };
  if (!stored.state) throw new Error(`Stored session "${sessionId}" has no turn state.`);
  const messages = stored.state.agent?.messages;
  if (!Array.isArray(messages)) throw new Error(`Stored session "${sessionId}" has no transcript.`);
  if (!messages.some((message) => message.role === "user")) {
    throw new Error(`Stored session "${sessionId}" has no user message.`);
  }

  const loaded = await loadRoutingTable({ cwd, catalogAdapter: routingCatalogAdapter });
  const selectedTier = stored.state.options?.model;
  const tier =
    selectedTier && loaded.table.tiers[selectedTier] ? selectedTier : loaded.table.defaultTier;
  const policy = loaded.table.tiers[tier]!.advisor;
  const model = resolveModelName(policy.target.modelName);
  const executorContext = await rebuildExecutorContext(
    stored.state,
    sessionId,
    cwd,
    model.contextWindow,
    options.memoryDbPath ?? DEFAULT_MEMORY_DB_PATH,
  );
  const transcript = buildAdvisorContext({
    context: executorContext,
    contextWindowTokens: model.contextWindow,
    reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
  });
  const estimates = Object.entries(loaded.table.tiers).map(([tierName, definition]) => {
    const model = definition.advisor.target.modelName;
    // Derived from the catalog's per-model cost (the same source the sidebar
    // and usage accounting bill from); zero means the catalog has no price.
    const resolvedModel = resolveModelName(model);
    const price = resolvedModel.cost?.input;
    const tierContext = buildAdvisorContext({
      context: executorContext,
      contextWindowTokens: resolvedModel.contextWindow,
      reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
    });
    return {
      tier: tierName,
      model,
      enabled: definition.advisor.enabled,
      inputUsd: price ? (tierContext.metadata.estimatedInputTokens / 1_000_000) * price : undefined,
    };
  });
  const result: AdvisorPreviewResult = {
    sessionId,
    tier,
    transcript: transcript.text,
    tokens: transcript.metadata.estimatedInputTokens,
    truncated: transcript.metadata.truncated,
    estimates,
  };
  write(renderAdvisorPreview(result));
  return result;
}

function renderAdvisorPreview(result: AdvisorPreviewResult): string {
  const estimates = result.estimates.map((estimate) => {
    const cost =
      estimate.inputUsd === undefined ? "price unavailable" : `$${estimate.inputUsd.toFixed(4)}`;
    return `- ${estimate.tier}: ${estimate.model}${estimate.enabled ? "" : " (disabled)"} — ${cost}`;
  });
  return [
    `Session: ${result.sessionId}`,
    `Tier: ${result.tier}`,
    `Transcript tokens: ${result.tokens}${result.truncated ? " (truncated)" : ""}`,
    "Estimated advisor input cost:",
    ...estimates,
    "",
    result.transcript,
    "",
  ].join("\n");
}

class AdvisorPreviewTurnRunner extends TurnRunner {
  async advisorContext(contextWindowTokens: number): Promise<AdvisorExecutorContext> {
    return await this.captureContextForAdvisor(contextWindowTokens, { drainObservations: false });
  }
}

async function rebuildExecutorContext(
  state: TurnState,
  sessionId: string,
  cwd: string,
  contextWindowTokens: number,
  memoryDbPath: string | false,
): Promise<AdvisorExecutorContext> {
  const runner = new AdvisorPreviewTurnRunner({
    cwd,
    sessionId,
    memoryDbPath,
    skillDiscovery: { includeDefaults: true },
  });
  try {
    await runner.start({ type: "start", mode: state.mode, state });
    return await runner.advisorContext(contextWindowTokens);
  } finally {
    await runner.dispose();
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
