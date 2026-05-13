import { DUET_GATEWAY_API_KEY_ENV } from "./duet-gateway.js";

export type ProviderName =
  | "duet-gateway"
  | "vercel-ai-gateway"
  | "openrouter"
  | "anthropic"
  | "openai";

export interface ProviderPreference {
  /** Provider identifier accepted by pi-ai or handled locally by model resolution. */
  provider: ProviderName;
  /** Env var override for providers whose credential is not discoverable through pi-ai. */
  customEnvVar?: () => string | null;
}

export interface ProviderModelCandidate {
  /** Provider that supports the candidate model. */
  provider: ProviderName;
  /** Fully resolved provider:modelId string passed to the runtime model loader. */
  modelName: string;
}

interface ModelDefinition {
  shorthand: string;
  aliases: readonly string[];
  modelsByProvider: Partial<Record<ProviderName, string>>;
}

export const DEFAULT_CLI_MODEL = "opus-4.7";
export const DEFAULT_CLI_MEMORY_MODEL = "gpt-5.4-mini";

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
  { provider: "anthropic" },
  { provider: "openai" },
];

const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  "duet-gateway": DEFAULT_CLI_MODEL,
  "vercel-ai-gateway": DEFAULT_CLI_MODEL,
  openrouter: DEFAULT_CLI_MODEL,
  anthropic: DEFAULT_CLI_MODEL,
  openai: "gpt-5.5",
};

const MEMORY_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  "duet-gateway": DEFAULT_CLI_MEMORY_MODEL,
  "vercel-ai-gateway": DEFAULT_CLI_MEMORY_MODEL,
  openrouter: DEFAULT_CLI_MEMORY_MODEL,
  anthropic: "haiku-4.5",
  openai: DEFAULT_CLI_MEMORY_MODEL,
};

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    shorthand: "opus-4.7",
    aliases: ["claude-opus-4.7", "claude-opus-4-7", "anthropic/claude-opus-4.7"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-opus-4.7",
      "vercel-ai-gateway": "anthropic/claude-opus-4.7",
      openrouter: "anthropic/claude-opus-4.7",
      anthropic: "claude-opus-4-7",
    },
  },
  {
    shorthand: "sonnet-4.6",
    aliases: ["claude-sonnet-4.6", "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-sonnet-4.6",
      "vercel-ai-gateway": "anthropic/claude-sonnet-4.6",
      openrouter: "anthropic/claude-sonnet-4.6",
      anthropic: "claude-sonnet-4-6",
    },
  },
  {
    shorthand: "haiku-4.5",
    aliases: ["claude-haiku-4.5", "claude-haiku-4-5", "anthropic/claude-haiku-4.5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-haiku-4.5",
      "vercel-ai-gateway": "anthropic/claude-haiku-4.5",
      openrouter: "anthropic/claude-haiku-4.5",
      anthropic: "claude-haiku-4-5",
    },
  },
  {
    shorthand: "gpt-5.5",
    aliases: ["openai/gpt-5.5"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.5",
      "vercel-ai-gateway": "openai/gpt-5.5",
      openrouter: "openai/gpt-5.5",
      openai: "gpt-5.5",
    },
  },
  {
    shorthand: "gpt-5.4-mini",
    aliases: ["openai/gpt-5.4-mini"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.4-mini",
      "vercel-ai-gateway": "openai/gpt-5.4-mini",
      openrouter: "openai/gpt-5.4-mini",
      openai: "gpt-5.4-mini",
    },
  },
];

export function isProviderPinnedModelName(modelName: string): boolean {
  return modelName.includes(":");
}

export function getProviderDefaultModel(provider: ProviderName): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function getProviderMemoryModel(provider: ProviderName): string {
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

function findModelDefinition(modelName: string): ModelDefinition | undefined {
  const normalized = modelName.toLowerCase();
  return MODEL_DEFINITIONS.find(
    (definition) => definition.shorthand === normalized || definition.aliases.includes(normalized),
  );
}

/**
 * Map user-friendly provider names (and common aliases) onto the canonical
 * `ProviderName`. Returns `undefined` for unknown values so callers can
 * surface a list of accepted names.
 */
export function resolveProviderShorthand(name: string): ProviderName | undefined {
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
    case "anthropic":
    case "claude":
      return "anthropic";
    case "openai":
    case "gpt":
      return "openai";
    default:
      return undefined;
  }
}

/** Names accepted by `--provider`, in canonical order, for help and errors. */
export const PROVIDER_SHORTHANDS: readonly string[] = [
  "duet",
  "vercel",
  "openrouter",
  "anthropic",
  "openai",
];

/** Build a `provider:modelId` reference for a provider's default chat model. */
export function pinnedDefaultModel(provider: ProviderName): string {
  return pinnedShorthand(provider, getProviderDefaultModel(provider));
}

/** Build a `provider:modelId` reference for a provider's memory model. */
export function pinnedMemoryModel(provider: ProviderName): string {
  return pinnedShorthand(provider, getProviderMemoryModel(provider));
}

function pinnedShorthand(provider: ProviderName, shorthand: string): string {
  const candidate = getModelCandidates(shorthand).find((entry) => entry.provider === provider);
  if (!candidate) {
    throw new Error(`Provider ${provider} has no model mapping for ${shorthand}`);
  }
  return candidate.modelName;
}
