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
  | "astra"
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
  /**
   * Provider-specific id used to carry this curated model on each supported
   * transport. List a transport only when it actually serves the model: an
   * unlisted transport falls through to the next candidate, while a listed one
   * the model catalog has not shipped resolves to an undefined model — except
   * on the gateways, which synthesize a conservative passthrough instead.
   *
   * Ids follow the transport's own namespace, which tracks the `TransportName`
   * union: `RouterProviderName` gateways aggregate many vendors and need the
   * `vendor/model` prefix to disambiguate, while a `ConnectedProviderId`
   * subscription is already scoped to one vendor and serves bare model names.
   */
  modelsByProvider: Partial<Record<TransportName, string>>;
  /**
   * Hard cap on output tokens, applied when it is lower than the `maxTokens`
   * the upstream pi-ai catalog reports. Some gateway models advertise a larger
   * window than the backend they actually route to accepts, so the request 400s
   * unless we clamp. Leave unset when the catalog value is already correct.
   */
  maxOutputTokens?: number;
}

export const DEFAULT_CLI_MODEL = "opus";
export const DEFAULT_CLI_MEMORY_MODEL = "luna";

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
  openrouter: DEFAULT_CLI_MEMORY_MODEL,
};

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    family: "opus",
    shorthand: "opus-5.5",
    aliases: ["claude-opus-5.5", "anthropic/claude-opus-5.5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-opus-5.5",
      "vercel-ai-gateway": "anthropic/claude-opus-5.5",
      openrouter: "anthropic/claude-opus-5.5",
      "github-copilot": "claude-opus-5.5",
    },
  },
  {
    family: "sonnet",
    shorthand: "sonnet-5.5",
    aliases: ["claude-sonnet-5.5", "anthropic/claude-sonnet-5.5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-sonnet-5.5",
      "vercel-ai-gateway": "anthropic/claude-sonnet-5.5",
    },
  },
  {
    // Gateway-only until anthropic-direct and openrouter serve Sonnet 5.
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
    // The default observational-memory model. Both gateways carry every OpenAI
    // model on the Responses transport rather than over anthropic-messages,
    // which would silently drop the low reasoning effort the observer and
    // reflectors request; see `gatewayApi` in duet-gateway.ts.
    family: "luna",
    shorthand: "gpt-6-luna",
    aliases: ["openai/gpt-6-luna"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-6-luna",
      "vercel-ai-gateway": "openai/gpt-6-luna",
      openrouter: "openai/gpt-6-luna",
      "openai-codex": "gpt-6-luna",
    },
  },
  {
    family: "sol",
    shorthand: "gpt-6-sol",
    aliases: ["openai/gpt-6-sol"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-6-sol",
      "vercel-ai-gateway": "openai/gpt-6-sol",
      openrouter: "openai/gpt-6-sol",
      "openai-codex": "gpt-6-sol",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "astra",
    shorthand: "gpt-6-astra",
    aliases: ["openai/gpt-6-astra"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-6-astra",
      "vercel-ai-gateway": "openai/gpt-6-astra",
      openrouter: "openai/gpt-6-astra",
      "openai-codex": "gpt-6-astra",
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
    // Gateway and OpenRouter use different vendor namespaces for Grok.
    family: "grok",
    shorthand: "grok-4.7",
    aliases: ["spacexai/grok-4.7", "spacexai/grok-4-7", "grok-4-7"],
    modelsByProvider: {
      "duet-gateway": "spacexai/grok-4.7",
      "vercel-ai-gateway": "spacexai/grok-4.7",
      openrouter: "x-ai/grok-4.7",
    },
  },
  {
    // Leads the deepseek family, so the `deepseek` alias resolves here.
    family: "deepseek",
    shorthand: "deepseek-v4.1-flash",
    aliases: ["deepseek/deepseek-v4.1-flash"],
    modelsByProvider: {
      "duet-gateway": "deepseek/deepseek-v4.1-flash",
      "vercel-ai-gateway": "deepseek/deepseek-v4.1-flash",
      openrouter: "deepseek/deepseek-v4.1-flash",
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
    // Leads the fable family used by the advisor. Connected-account
    // availability is still checked by the provider hook.
    family: "fable",
    shorthand: "fable-5.1",
    aliases: [
      "claude-fable-5.1",
      "claude-fable-5-1",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-fable-5-1",
    ],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-fable-5.1",
      "vercel-ai-gateway": "anthropic/claude-fable-5.1",
      openrouter: "anthropic/claude-fable-5.1",
      "github-copilot": "claude-fable-5.1",
    },
  },
  {
    // The previous fable, kept resolvable as a versioned pin.
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
    // Zhipu's GLM 5.3 is routed through the duet/vercel gateways under the
    // `zai/glm-5.3` model id and through OpenRouter as `z-ai/glm-5.3`. We do not
    // configure a direct Zhipu provider, so these are the only routes.
    family: "glm",
    shorthand: "glm-5.3",
    aliases: ["zai/glm-5.3", "z-ai/glm-5.3", "glm-5-3"],
    modelsByProvider: {
      "duet-gateway": "zai/glm-5.3",
      "vercel-ai-gateway": "zai/glm-5.3",
      openrouter: "z-ai/glm-5.3",
    },
  },
];

const familyLatest: Partial<Record<FamilyName, string>> = {};
const shorthandsByFamily: Partial<Record<FamilyName, string[]>> = {};
for (const definition of MODEL_DEFINITIONS) {
  familyLatest[definition.family] ??= definition.shorthand;
  (shorthandsByFamily[definition.family] ??= []).push(definition.shorthand);
}

// Terra remains a durable selection for the coding role now served by Sol.
familyLatest.terra = familyLatest.sol;
shorthandsByFamily.terra = shorthandsByFamily.sol;

/**
 * Every curated shorthand, grouped by family in catalog order. Exported so
 * coverage checks enumerate the catalog itself rather than a hand-maintained
 * roster a newly added model would silently escape.
 */
export const SHORTHANDS_BY_FAMILY = Object.freeze(
  shorthandsByFamily as Record<FamilyName, readonly string[]>,
);

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

/** Every model id a transport serves, in catalog order. */
export function transportModelIds(transport: TransportName): string[] {
  return MODEL_DEFINITIONS.flatMap((definition) => {
    const modelId = definition.modelsByProvider[transport];
    return modelId ? [modelId] : [];
  });
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
 * pass familiar variants like `claude-opus-5-5` even when the underlying
 * provider catalog spells it `claude-opus-5.5`. Falls back to the input id
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
  return `${provider}:${getProviderDefaultModel(provider)}`;
}

/** Build a `provider:modelId` reference for a provider's memory model. */
export function pinnedMemoryModel(provider: RouterProviderName): string {
  return `${provider}:${getProviderMemoryModel(provider)}`;
}

/** Recover family intent from saved sessions and routing configuration.
 * Known replaced targets retain their transport; unknown selections and historical
 * message attribution stay untouched. */
export function normalizeSavedModelSelection(modelName: string): string;
export function normalizeSavedModelSelection(modelName: string | undefined): string | undefined;
export function normalizeSavedModelSelection(modelName: string | undefined): string | undefined {
  const savedFamilies: Readonly<Record<string, FamilyName>> = {
    "opus-5": "opus",
    "opus-4.8": "opus",
    "opus-4.7": "opus",
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
    "gpt-5.6-luna": "luna",
    "grok-4.3": "grok",
    "glm-5.2": "glm",
    "glm-4.7": "glm",
  };
  if (modelName === undefined) return undefined;
  const separator = modelName.indexOf(":");
  const id = separator === -1 ? modelName : modelName.slice(separator + 1);
  const family =
    savedFamilies[
      id
        .toLowerCase()
        .replace(/^(?:anthropic|openai|xai|x-ai|zai|z-ai)\//, "")
        .replace(/^claude-/, "")
        .replace(/(\d)-(?=\d)/g, "$1.")
    ];
  if (!family) return modelName;
  if (separator === -1) return family;
  const rawProvider = modelName.slice(0, separator);
  const router = resolveProviderShorthand(rawProvider);
  if (router) return `${rawProvider}:${family}`;
  if (rawProvider === "openai-codex" || rawProvider === "github-copilot") {
    const target = transportModelId(rawProvider, family);
    if (target) return `${rawProvider}:${target}`;
  }
  return modelName;
}
