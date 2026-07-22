import type { TransportName } from "../model-resolution/catalog.js";
import type { ConnectedProviderId } from "./store.js";

export type TransportFallbackCause = "plan_exhausted" | "auth_failed" | "transport_error";

/** Own the single user-visible sentence emitted when a connected call falls back. */
export function transportFallbackNotice(input: {
  provider: ConnectedProviderId;
  modelName: string;
  fallbackTransport: TransportName;
  cause: TransportFallbackCause;
}): string {
  const provider = input.provider === "openai-codex" ? "ChatGPT" : "Copilot";
  const reason =
    input.cause === "plan_exhausted"
      ? "plan limit hit"
      : input.cause === "auth_failed"
        ? "connection needs attention"
        : "plan transport unavailable";
  return `${provider} ${reason} for ${input.modelName} — continuing on ${transportLabel(input.fallbackTransport)}.`;
}

function transportLabel(transport: TransportName): string {
  if (transport === "duet-gateway") return "Duet credits";
  if (transport === "vercel-ai-gateway") return "Vercel AI Gateway";
  if (transport === "openrouter") return "OpenRouter";
  return transport === "openai-codex" ? "ChatGPT plan" : "Copilot plan";
}
