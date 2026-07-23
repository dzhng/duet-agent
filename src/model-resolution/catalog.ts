import { DUET_GATEWAY_API_KEY_ENV } from "./duet-gateway.js";
import type { ConnectedProviderId } from "../connected-providers/store.js";

/** Metered providers considered by the router when resolving an unpinned model. */
export type RouterProviderName = "duet-gateway" | "vercel-ai-gateway" | "openrouter";

/** Any backend capable of carrying a curated catalog model. */
export type TransportName = RouterProviderName | ConnectedProviderId;

/** Versionless model families accepted anywhere a curated shorthand is accepted. */
export type FamilyName =
  | "fable"
  | "opus"
  | "sonnet"
  | "haiku"
  | "sol"
  | "terra"
  | "luna"
  | "kimi"
  | "grok"
  | "deepseek"
  | "glm";

export interface ProviderPreference {
  /** Provider identifier accepted by pi-ai or handled locally by model resolution. */
  provider: RouterProviderName;
  /** Env var override for providers whose credential is not discoverable through pi-ai. */
  customEnvVar?: () => string | null;
}

export interface ProviderModelCandidate {
  /** Provider that supports the candidate model. */
  provider: RouterProviderName;
  /** Fully resolved provider:modelId string passed to the runtime model loader. */
  modelName: string;
}

interface ModelDefinition {
  /** Versionless name whose first catalog entry is the family's latest model. */
  family: FamilyName;
  shorthand: string;
  aliases: readonly string[];
  /** Provider-specific id used to carry this curated model on each supported transport. */
  modelsByProvider: Partial<Record<TransportName, string>>;
  /**
   * Hard cap on output tokens, applied when it is lower than the `maxTokens`
   * the upstream pi-ai catalog reports. Some gateway models advertise a larger
   * window than the backend they actually route to accepts, so the request 400s
   * unless we clamp. Leave unset when the catalog value is already correct.
   */
  maxOutputTokens?: number;
}

export const DEFAULT_CLI_MODEL = "opus-4.8";
export const DEFAULT_CLI_MEMORY_MODEL = "gpt-5.6-luna";

/**
 * Global provider preference for shorthand resolution. `duet-gateway` must
 * stay before `vercel-ai-gateway` because CLI startup mirrors DUET_API_KEY into
 * AI_GATEWAY_API_KEY for the gateway transport.
 */
export const PROVIDER_ORDER: readonly ProviderPreference[] = [
  {
    provider: "duet-gateway",
    customEnvVar: () => (process.env[DUET_GATEWAY_API_KEY_ENV] ? DUET_GATEWAY_API_KEY_ENV : null),
  },
  { provider: "vercel-ai-gateway" },
  { provider: "openrouter" },
];

const DEFAULT_MODEL_BY_PROVIDER: Record<RouterProviderName, string> = {
  "duet-gateway": DEFAULT_CLI_MODEL,
  "vercel-ai-gateway": DEFAULT_CLI_MODEL,
  openrouter: DEFAULT_CLI_MODEL,
};

const MEMORY_MODEL_BY_PROVIDER: Record<RouterProviderName, string> = {
  "duet-gateway": DEFAULT_CLI_MEMORY_MODEL,
  "vercel-ai-gateway": DEFAULT_CLI_MEMORY_MODEL,
  // Memory stays on luna for every router. OpenRouter serves luna even
  // though pi-ai's catalog lags — resolution clones a shipped OpenRouter
  // sibling (MISSING_MODEL_CLONES in duet-gateway.ts).
  openrouter: DEFAULT_CLI_MEMORY_MODEL,
};

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    family: "opus",
    shorthand: "opus-4.8",
    aliases: [
      "claude-opus-4.8",
      "claude-opus-4-8",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4-8",
    ],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-opus-4.8",
      "vercel-ai-gateway": "anthropic/claude-opus-4.8",
      openrouter: "anthropic/claude-opus-4.8",
      "github-copilot": "claude-opus-4.8",
    },
  },
  {
    family: "opus",
    shorthand: "opus-4.7",
    aliases: [
      "claude-opus-4.7",
      "claude-opus-4-7",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4-7",
    ],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-opus-4.7",
      "vercel-ai-gateway": "anthropic/claude-opus-4.7",
      openrouter: "anthropic/claude-opus-4.7",
      "github-copilot": "claude-opus-4.7",
    },
  },
  {
    // Anthropic's Claude Sonnet 5 is routed through the duet/vercel gateways
    // under the `anthropic/claude-sonnet-5` model id. pi-ai's catalog does not
    // ship it yet — not on the gateway, anthropic-direct, or OpenRouter — so
    // resolution clones the Opus 4.8 gateway entry (identical anthropic-messages
    // transport, 1M context, 128k output cap) until it does; see
    // `resolveMissingModel` in duet-gateway.ts. Only the gateway routes are
    // listed because the clone backs `vercel-ai-gateway` (which `duet-gateway`
    // resolves through); add the anthropic/openrouter routes once pi-ai ships
    // them so a pinned resolve does not fall through to an undefined model.
    family: "sonnet",
    shorthand: "sonnet-5",
    aliases: ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-sonnet-5",
      "vercel-ai-gateway": "anthropic/claude-sonnet-5",
    },
  },
  {
    family: "sonnet",
    shorthand: "sonnet-4.6",
    aliases: [
      "claude-sonnet-4.6",
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4-6",
    ],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-sonnet-4.6",
      "vercel-ai-gateway": "anthropic/claude-sonnet-4.6",
      openrouter: "anthropic/claude-sonnet-4.6",
      "github-copilot": "claude-sonnet-4.6",
    },
  },
  {
    family: "haiku",
    shorthand: "haiku-4.5",
    aliases: [
      "claude-haiku-4.5",
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-haiku-4-5",
    ],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-haiku-4.5",
      "vercel-ai-gateway": "anthropic/claude-haiku-4.5",
      openrouter: "anthropic/claude-haiku-4.5",
      "github-copilot": "claude-haiku-4.5",
    },
  },
  {
    // OpenAI's gpt-5.6-luna is the default observational-memory model. It routes
    // through the duet and vercel gateways under `openai/gpt-5.6-luna`, both of
    // which synthesize an openai-responses passthrough for it (the duet path via
    // `resolveDuetGatewayUpstream`, the vercel path via `resolveMissingModel` in
    // duet-gateway.ts) so its low reasoning effort survives to the wire. The
    // OpenRouter route is served live but absent from pi-ai's catalog, so it
    // resolves through the openrouter MISSING_MODEL_CLONES entry.
    family: "luna",
    shorthand: "gpt-5.6-luna",
    aliases: ["openai/gpt-5.6-luna", "openai/gpt-5-6-luna"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-luna",
      "vercel-ai-gateway": "openai/gpt-5.6-luna",
      // OpenRouter serves luna; pi-ai's catalog lags, so resolution clones a
      // shipped OpenRouter sibling (MISSING_MODEL_CLONES in duet-gateway.ts).
      openrouter: "openai/gpt-5.6-luna",
      "openai-codex": "gpt-5.6-luna",
    },
  },
  {
    family: "sol",
    shorthand: "gpt-5.6-sol",
    aliases: ["openai/gpt-5.6-sol", "openai/gpt-5-6-sol"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-sol",
      "vercel-ai-gateway": "openai/gpt-5.6-sol",
      openrouter: "openai/gpt-5.6-sol",
      "openai-codex": "gpt-5.6-sol",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "terra",
    shorthand: "gpt-5.6-terra",
    aliases: ["openai/gpt-5.6-terra", "openai/gpt-5-6-terra"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-terra",
      "vercel-ai-gateway": "openai/gpt-5.6-terra",
      openrouter: "openai/gpt-5.6-terra",
      "openai-codex": "gpt-5.6-terra",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "kimi",
    shorthand: "kimi-k3",
    aliases: ["moonshotai/kimi-k3"],
    modelsByProvider: {
      "duet-gateway": "moonshotai/kimi-k3",
      "vercel-ai-gateway": "moonshotai/kimi-k3",
      openrouter: "moonshotai/kimi-k3",
    },
    // Moonshot's provider route advertises a 131k maximum completion.
    maxOutputTokens: 131072,
  },
  {
    // xAI's Grok 4.3 is routed through the duet/vercel gateways under the
    // `xai/grok-4.3` model id. We do not currently configure a direct xAI
    // provider, so the gateway entries are the only routes.
    family: "grok",
    shorthand: "grok-4.3",
    aliases: ["xai/grok-4.3", "xai/grok-4-3", "grok-4-3"],
    modelsByProvider: {
      "duet-gateway": "xai/grok-4.3",
      "vercel-ai-gateway": "xai/grok-4.3",
      openrouter: "x-ai/grok-4.3",
    },
  },
  {
    // DeepSeek V4 Pro is routed through the duet/vercel gateways and OpenRouter
    // under the shared `deepseek/deepseek-v4-pro` model id. We do not configure
    // a direct DeepSeek provider, so the gateway and OpenRouter entries are the
    // only routes.
    family: "deepseek",
    shorthand: "deepseek-v4-pro",
    aliases: ["deepseek/deepseek-v4-pro"],
    modelsByProvider: {
      "duet-gateway": "deepseek/deepseek-v4-pro",
      "vercel-ai-gateway": "deepseek/deepseek-v4-pro",
      openrouter: "deepseek/deepseek-v4-pro",
    },
    // The gateways route this model to baseten, whose API rejects max_tokens
    // above 262144 even though pi-ai's catalog advertises 384000.
    maxOutputTokens: 262144,
  },
  {
    // Anthropic's Claude Fable 5 uses `anthropic/claude-fable-5` on every router
    // provider. pi-ai's catalog does not ship it yet, so resolution clones the
    // Opus 4.8 entry (identical anthropic-messages transport, 1M context, 128k
    // output cap) until it does; see `resolveMissingModel` in duet-gateway.ts.
    family: "fable",
    shorthand: "fable-5",
    aliases: ["claude-fable-5", "anthropic/claude-fable-5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-fable-5",
      "vercel-ai-gateway": "anthropic/claude-fable-5",
      openrouter: "anthropic/claude-fable-5",
      "github-copilot": "claude-fable-5",
    },
  },
  {
    // Zhipu's GLM 5.2 is routed through the duet/vercel gateways under the
    // `zai/glm-5.2` model id and through OpenRouter as `z-ai/glm-5.2`. We do not
    // configure a direct Zhipu provider, so these are the only routes.
    family: "glm",
    shorthand: "glm-5.2",
    aliases: ["zai/glm-5.2", "z-ai/glm-5.2", "glm-5-2"],
    modelsByProvider: {
      "duet-gateway": "zai/glm-5.2",
      "vercel-ai-gateway": "zai/glm-5.2",
      openrouter: "z-ai/glm-5.2",
    },
  },
  {
    // Zhipu's GLM 4.7 is routed through the duet/vercel gateways under the
    // `zai/glm-4.7` model id and through OpenRouter as `z-ai/glm-4.7`. We do not
    // configure a direct Zhipu provider, so these are the only routes.
    family: "glm",
    shorthand: "glm-4.7",
    aliases: ["zai/glm-4.7", "z-ai/glm-4.7", "glm-4-7"],
    modelsByProvider: {
      "duet-gateway": "zai/glm-4.7",
      "vercel-ai-gateway": "zai/glm-4.7",
      openrouter: "z-ai/glm-4.7",
    },
  },
];

const familyLatest: Partial<Record<FamilyName, string>> = {};
for (const definition of MODEL_DEFINITIONS) {
  familyLatest[definition.family] ??= definition.shorthand;
}

/** Latest shorthand for each family, derived from the first matching catalog entry. */
export const FAMILY_LATEST = Object.freeze(familyLatest as Record<FamilyName, string>);

/** Resolve a versionless family name to the first versioned shorthand in catalog order. */
export function resolveFamilyShorthand(name: string): string | undefined {
  return FAMILY_LATEST[name.trim().toLowerCase() as FamilyName];
}

export function isProviderPinnedModelName(modelName: string): boolean {
  return modelName.includes(":");
}

/**
 * Clamp a resolved model's output-token ceiling to the catalog's
 * `maxOutputTokens` when one is set and lower than the upstream value. Returns
 * the input unchanged when no override applies, so unknown or already-correct
 * models pass through untouched.
 */
export function clampModelOutputTokens<T extends { id: string; maxTokens: number }>(model: T): T {
  // `getModel` returns undefined at runtime for pass-through provider:modelId
  // values that are not in the catalog; resolution must forward those untouched
  // rather than dereference a missing model.
  if (!model) return model;
  const cap = findModelDefinition(model.id)?.maxOutputTokens;
  if (cap === undefined || model.maxTokens <= cap) return model;
  return { ...model, maxTokens: cap };
}

export function getProviderDefaultModel(provider: RouterProviderName): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function getProviderMemoryModel(provider: RouterProviderName): string {
  return MEMORY_MODEL_BY_PROVIDER[provider];
}

export function getModelCandidates(modelName: string): readonly ProviderModelCandidate[] {
  const definition = findModelDefinition(modelName);
  if (!definition) return [];

  return PROVIDER_ORDER.flatMap(({ provider }) => {
    const modelId = definition.modelsByProvider[provider];
    return modelId ? [{ provider, modelName: `${provider}:${modelId}` }] : [];
  });
}

export function isKnownShorthand(modelName: string): boolean {
  return Boolean(findModelDefinition(modelName));
}

export function canonicalizeModelName(modelName: string): string {
  return findModelDefinition(modelName)?.shorthand ?? modelName;
}

/** Resolve a curated shorthand or alias to the id served by a specific transport. */
export function transportModelId(transport: TransportName, shorthand: string): string | undefined {
  return findModelDefinition(shorthand)?.modelsByProvider[transport];
}

/** Recover the curated shorthand represented by a transport-specific model id. */
export function shorthandForTransportModel(
  transport: TransportName,
  modelId: string,
): string | undefined {
  return MODEL_DEFINITIONS.find((definition) => definition.modelsByProvider[transport] === modelId)
    ?.shorthand;
}

/**
 * Normalize a `provider:modelId` model id against catalog aliases so users can
 * pass familiar variants like `claude-opus-4-7` even when the underlying
 * provider catalog spells it `claude-opus-4.7`. Falls back to the input id
 * when no alias matches so unknown ids reach the provider lookup unchanged.
 */
export function canonicalizeProviderModelId(provider: RouterProviderName, modelId: string): string {
  const definition = findModelDefinition(modelId);
  if (!definition) return modelId;
  return definition.modelsByProvider[provider] ?? modelId;
}

function findModelDefinition(modelName: string): ModelDefinition | undefined {
  const normalized = modelName.toLowerCase();
  const familyShorthand = resolveFamilyShorthand(normalized);
  return MODEL_DEFINITIONS.find(
    (definition) =>
      definition.shorthand === (familyShorthand ?? normalized) ||
      definition.aliases.includes(normalized),
  );
}

/**
 * Map user-friendly provider names (and common aliases) onto the canonical
 * `RouterProviderName`. Returns `undefined` for unknown values so callers can
 * surface a list of accepted names.
 */
export function resolveProviderShorthand(name: string): RouterProviderName | undefined {
  switch (name.trim().toLowerCase()) {
    case "duet":
    case "duet-gateway":
      return "duet-gateway";
    case "vercel":
    case "vercel-gateway":
    case "vercel-ai-gateway":
    case "ai-gateway":
      return "vercel-ai-gateway";
    case "openrouter":
      return "openrouter";
    default:
      return undefined;
  }
}

/** Names accepted by `--provider`, in canonical order, for help and errors. */
export const PROVIDER_SHORTHANDS: readonly string[] = ["duet", "vercel", "openrouter"];

/** Build a `provider:modelId` reference for a provider's default chat model. */
export function pinnedDefaultModel(provider: RouterProviderName): string {
  return pinnedShorthand(provider, getProviderDefaultModel(provider));
}

/** Build a `provider:modelId` reference for a provider's memory model. */
export function pinnedMemoryModel(provider: RouterProviderName): string {
  return pinnedShorthand(provider, getProviderMemoryModel(provider));
}

function pinnedShorthand(provider: RouterProviderName, shorthand: string): string {
  const candidate = getModelCandidates(shorthand).find((entry) => entry.provider === provider);
  if (!candidate) {
    throw new Error(`Provider ${provider} has no model mapping for ${shorthand}`);
  }
  return candidate.modelName;
}
