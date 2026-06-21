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
  /**
   * Hard cap on output tokens, applied when it is lower than the `maxTokens`
   * the upstream pi-ai catalog reports. Some gateway models advertise a larger
   * window than the backend they actually route to accepts, so the request 400s
   * unless we clamp. Leave unset when the catalog value is already correct.
   */
  maxOutputTokens?: number;
}

export const DEFAULT_CLI_MODEL = "opus-4.8";
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
      anthropic: "claude-opus-4-8",
    },
  },
  {
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
      anthropic: "claude-opus-4-7",
    },
  },
  {
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
      anthropic: "claude-sonnet-4-6",
    },
  },
  {
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
      anthropic: "claude-haiku-4-5",
    },
  },
  {
    shorthand: "gpt-5.5",
    aliases: ["openai/gpt-5.5", "openai/gpt-5-5"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.5",
      "vercel-ai-gateway": "openai/gpt-5.5",
      openrouter: "openai/gpt-5.5",
      openai: "gpt-5.5",
    },
  },
  {
    shorthand: "gpt-5.4-mini",
    aliases: ["openai/gpt-5.4-mini", "openai/gpt-5-4-mini"],
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.4-mini",
      "vercel-ai-gateway": "openai/gpt-5.4-mini",
      openrouter: "openai/gpt-5.4-mini",
      openai: "gpt-5.4-mini",
    },
  },
  {
    // xAI's Grok 4.3 is routed through the duet/vercel gateways under the
    // `xai/grok-4.3` model id. We do not currently configure a direct xAI
    // provider, so the gateway entries are the only routes.
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
    // Anthropic's Claude Fable 5 is routed through the duet/vercel gateways
    // under the `anthropic/claude-fable-5` model id. pi-ai's catalog does not
    // ship it yet, so resolution clones the Opus 4.8 gateway entry (identical
    // anthropic-messages transport, 1M context, 128k output cap) until it does;
    // see `resolveMissingModel` in duet-gateway.ts.
    shorthand: "fable-5",
    aliases: ["claude-fable-5", "anthropic/claude-fable-5"],
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-fable-5",
      "vercel-ai-gateway": "anthropic/claude-fable-5",
      anthropic: "claude-fable-5",
    },
  },
  {
    // Zhipu's GLM 4.7 is routed through the duet/vercel gateways under the
    // `zai/glm-4.7` model id and through OpenRouter as `z-ai/glm-4.7`. We do not
    // configure a direct Zhipu provider, so these are the only routes.
    shorthand: "glm-4.7",
    aliases: ["zai/glm-4.7", "z-ai/glm-4.7", "glm-4-7"],
    modelsByProvider: {
      "duet-gateway": "zai/glm-4.7",
      "vercel-ai-gateway": "zai/glm-4.7",
      openrouter: "z-ai/glm-4.7",
    },
  },
  {
    // Zhipu's GLM 5.2 is routed through the duet/vercel gateways under the
    // `zai/glm-5.2` model id and through OpenRouter as `z-ai/glm-5.2`. We do not
    // configure a direct Zhipu provider, so these are the only routes.
    shorthand: "glm-5.2",
    aliases: ["zai/glm-5.2", "z-ai/glm-5.2", "glm-5-2"],
    modelsByProvider: {
      "duet-gateway": "zai/glm-5.2",
      "vercel-ai-gateway": "zai/glm-5.2",
      openrouter: "z-ai/glm-5.2",
    },
  },
];

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

/**
 * Normalize a `provider:modelId` model id against catalog aliases so users can
 * pass familiar variants like `claude-opus-4-7` even when the underlying
 * provider catalog spells it `claude-opus-4.7`. Falls back to the input id
 * when no alias matches so unknown ids reach the provider lookup unchanged.
 */
export function canonicalizeProviderModelId(provider: ProviderName, modelId: string): string {
  const definition = findModelDefinition(modelId);
  if (!definition) return modelId;
  return definition.modelsByProvider[provider] ?? modelId;
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
