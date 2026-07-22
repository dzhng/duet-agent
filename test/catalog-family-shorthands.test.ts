import { describe, expect, test } from "bun:test";
import {
  FAMILY_LATEST,
  canonicalizeModelName,
  getModelCandidates,
  isKnownShorthand,
  resolveFamilyShorthand,
  type FamilyName,
  type ProviderName,
} from "../src/model-resolution/catalog.js";

interface FamilyCase {
  family: FamilyName;
  latest: string;
  modelsByProvider: Partial<Record<ProviderName, string>>;
}

const familyCases: readonly FamilyCase[] = [
  {
    family: "fable",
    latest: "fable-5",
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-fable-5",
      "vercel-ai-gateway": "anthropic/claude-fable-5",
      openrouter: "anthropic/claude-fable-5",
    },
  },
  {
    family: "opus",
    latest: "opus-4.8",
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-opus-4.8",
      "vercel-ai-gateway": "anthropic/claude-opus-4.8",
      openrouter: "anthropic/claude-opus-4.8",
    },
  },
  {
    family: "sonnet",
    latest: "sonnet-5",
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-sonnet-5",
      "vercel-ai-gateway": "anthropic/claude-sonnet-5",
    },
  },
  {
    family: "haiku",
    latest: "haiku-4.5",
    modelsByProvider: {
      "duet-gateway": "anthropic/claude-haiku-4.5",
      "vercel-ai-gateway": "anthropic/claude-haiku-4.5",
      openrouter: "anthropic/claude-haiku-4.5",
    },
  },
  {
    family: "sol",
    latest: "gpt-5.6-sol",
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-sol",
      "vercel-ai-gateway": "openai/gpt-5.6-sol",
      openrouter: "openai/gpt-5.6-sol",
    },
  },
  {
    family: "terra",
    latest: "gpt-5.6-terra",
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-terra",
      "vercel-ai-gateway": "openai/gpt-5.6-terra",
      openrouter: "openai/gpt-5.6-terra",
    },
  },
  {
    family: "luna",
    latest: "gpt-5.6-luna",
    modelsByProvider: {
      "duet-gateway": "openai/gpt-5.6-luna",
      "vercel-ai-gateway": "openai/gpt-5.6-luna",
    },
  },
  {
    family: "kimi",
    latest: "kimi-k3",
    modelsByProvider: {
      "duet-gateway": "moonshotai/kimi-k3",
      "vercel-ai-gateway": "moonshotai/kimi-k3",
      openrouter: "moonshotai/kimi-k3",
    },
  },
  {
    family: "grok",
    latest: "grok-4.3",
    modelsByProvider: {
      "duet-gateway": "xai/grok-4.3",
      "vercel-ai-gateway": "xai/grok-4.3",
      openrouter: "x-ai/grok-4.3",
    },
  },
  {
    family: "deepseek",
    latest: "deepseek-v4-pro",
    modelsByProvider: {
      "duet-gateway": "deepseek/deepseek-v4-pro",
      "vercel-ai-gateway": "deepseek/deepseek-v4-pro",
      openrouter: "deepseek/deepseek-v4-pro",
    },
  },
  {
    family: "glm",
    latest: "glm-5.2",
    modelsByProvider: {
      "duet-gateway": "zai/glm-5.2",
      "vercel-ai-gateway": "zai/glm-5.2",
      openrouter: "z-ai/glm-5.2",
    },
  },
];

const providers: readonly ProviderName[] = ["duet-gateway", "vercel-ai-gateway", "openrouter"];

describe("catalog family shorthands", () => {
  test("resolves every family to one latest shorthand and its provider models", () => {
    expect(Object.entries(FAMILY_LATEST).sort()).toEqual(
      familyCases.map(({ family, latest }): [string, string] => [family, latest]).sort(),
    );

    for (const { family, latest, modelsByProvider } of familyCases) {
      expect(resolveFamilyShorthand(family), family).toBe(latest);
      expect(canonicalizeModelName(family), family).toBe(latest);
      expect(isKnownShorthand(family), family).toBe(true);
      expect(getModelCandidates(family), family).toEqual(
        providers.flatMap((provider) => {
          const modelId = modelsByProvider[provider];
          return modelId ? [{ provider, modelName: `${provider}:${modelId}` }] : [];
        }),
      );
    }
  });

  test("keeps every surviving versioned shorthand resolvable", () => {
    const survivingShorthands = [
      "fable-5",
      "opus-4.8",
      "opus-4.7",
      "sonnet-5",
      "sonnet-4.6",
      "haiku-4.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "kimi-k3",
      "grok-4.3",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-4.7",
    ];

    for (const shorthand of survivingShorthands) {
      expect(isKnownShorthand(shorthand), shorthand).toBe(true);
      expect(canonicalizeModelName(shorthand), shorthand).toBe(shorthand);
      expect(getModelCandidates(shorthand).length, shorthand).toBeGreaterThan(0);
    }
  });

  test("does not resolve deleted pre-5.6 OpenAI shorthands or aliases", () => {
    for (const deletedName of [
      "gpt-5.5",
      "openai/gpt-5.5",
      "openai/gpt-5-5",
      "gpt-5.4-mini",
      "openai/gpt-5.4-mini",
      "openai/gpt-5-4-mini",
    ]) {
      expect(isKnownShorthand(deletedName), deletedName).toBe(false);
      expect(getModelCandidates(deletedName), deletedName).toEqual([]);
    }
  });
});
