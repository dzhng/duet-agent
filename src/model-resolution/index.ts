import { findEnvKeys } from "@mariozechner/pi-ai";

import { DUET_GATEWAY_API_KEY_ENV } from "../duet-gateway/index.js";

/**
 * Resolves which provider:modelId the CLI talks to, plus the provenance for
 * that decision (explicit flag, inferred from env, or built-in fallback). The
 * shape lives in its own module so cli.ts stays focused on argv parsing and
 * the I/O harness — provider list changes don't touch the CLI surface.
 */

const INFERRED_ANTHROPIC_MODEL = "anthropic:claude-opus-4-7";
const INFERRED_AI_GATEWAY_MODEL = "vercel-ai-gateway:anthropic/claude-opus-4.7";
const INFERRED_DUET_GATEWAY_MODEL = "duet-gateway:anthropic/claude-opus-4.7";
const INFERRED_OPENROUTER_MODEL = "openrouter:anthropic/claude-opus-4.7";
const INFERRED_OPENAI_MODEL = "openai:gpt-5.5";

export const DEFAULT_CLI_MODEL = INFERRED_ANTHROPIC_MODEL;

export interface ModelResolution {
  modelName: string;
  /** explicit: --model flag; inferred: provider env var present; default: built-in fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "ANTHROPIC_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from <workdir>/.env rather than the shell. */
  fromDotenv?: boolean;
}

/**
 * Provider inference order. Entries are tried top-to-bottom; the first one
 * with a present env var wins. `customEnvVar` covers providers pi-ai's
 * `findEnvKeys` doesn't know about (currently only `duet-gateway`).
 *
 * `duet-gateway` sits before `vercel-ai-gateway` because the CLI startup shim
 * copies `DUET_API_KEY` into `AI_GATEWAY_API_KEY`, which would otherwise route
 * through Vercel's gateway directly when the user only set `DUET_API_KEY`.
 */
const PROVIDER_INFERENCE: Array<{
  provider: string;
  model: string;
  customEnvVar?: () => string | null;
}> = [
  { provider: "anthropic", model: INFERRED_ANTHROPIC_MODEL },
  {
    provider: "duet-gateway",
    model: INFERRED_DUET_GATEWAY_MODEL,
    customEnvVar: () => (process.env[DUET_GATEWAY_API_KEY_ENV] ? DUET_GATEWAY_API_KEY_ENV : null),
  },
  { provider: "vercel-ai-gateway", model: INFERRED_AI_GATEWAY_MODEL },
  { provider: "openrouter", model: INFERRED_OPENROUTER_MODEL },
  { provider: "openai", model: INFERRED_OPENAI_MODEL },
];

function lookupProviderEnvVar(entry: (typeof PROVIDER_INFERENCE)[number]): string | undefined {
  if (entry.customEnvVar) {
    return entry.customEnvVar() ?? undefined;
  }
  const envVars = findEnvKeys(entry.provider);
  return envVars && envVars.length > 0 ? envVars[0] : undefined;
}

export function inferDefaultModelName(): string | undefined {
  for (const entry of PROVIDER_INFERENCE) {
    if (lookupProviderEnvVar(entry)) return entry.model;
  }
  return undefined;
}

export function resolveCliModelName(modelName: string | undefined): string {
  return resolveCliModel(modelName).modelName;
}

/**
 * Same selection logic as resolveCliModelName, but also reports the provenance
 * so callers can show "inferred from ANTHROPIC_API_KEY in .env" etc.
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string> = new Set(),
): ModelResolution {
  if (modelName) return { modelName, source: "explicit" };
  for (const entry of PROVIDER_INFERENCE) {
    const envVar = lookupProviderEnvVar(entry);
    if (envVar) {
      return {
        modelName: entry.model,
        source: "inferred",
        envVar,
        fromDotenv: dotenvKeys.has(envVar),
      };
    }
  }
  return { modelName: DEFAULT_CLI_MODEL, source: "default" };
}

export function describeModelResolution(resolution: ModelResolution): string {
  if (resolution.source === "explicit") return "--model flag";
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "<workdir>/.env" : "shell environment";
    return `inferred from ${resolution.envVar} in ${where}`;
  }
  return "built-in default (no provider env vars set)";
}
