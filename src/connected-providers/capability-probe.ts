import {
  complete,
  getModels,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { connectedProviders } from "./registry.js";
import type { ConnectedProviderId, ConnectionEligibility } from "./store.js";

const CHATGPT_SERVED_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const CHATGPT_PROBE_MODEL_ID = "gpt-5.6-luna";

export interface CapabilityProbeResult {
  /** Whether this account can serve plan-covered model traffic. */
  eligibility: ConnectionEligibility;
  /** Provider model ids available to the connected account. */
  servedModelIds: string[];
  /** Stable redacted reason when eligibility could not be confirmed. */
  detail?: string;
}

export interface CapabilityProbeDependencies {
  /** Completion edge replaced by deterministic HTTP-status fixtures in tests. */
  complete?: (
    model: Model<Api>,
    context: Context,
    options?: ProviderStreamOptions,
  ) => Promise<AssistantMessage>;
}

export async function probeConnectedProvider(
  id: ConnectedProviderId,
  credentials: OAuthCredentials,
  deps: CapabilityProbeDependencies = {},
): Promise<CapabilityProbeResult> {
  const provider = connectedProviders()
    .find((entry) => entry.id === id)
    ?.oauth();
  if (!provider) return unknown("Provider is not registered.");

  const catalog = getModels(id);
  const available = provider.modifyModels?.(catalog, credentials) ?? catalog;
  const servedModelIds =
    id === "openai-codex" ? [...CHATGPT_SERVED_MODEL_IDS] : available.map((model) => model.id);
  const copilotHasNoModels = id === "github-copilot" && hasEmptyAvailableModelIds(credentials);
  // An ineligible Copilot account filters every model out. Probe a catalog donor
  // anyway so connect still exercises the transport and observes its stop=error.
  const model = selectProbeModel(id, available.length > 0 ? available : catalog);
  if (!model) return unknown("No probe model is available.");

  let responseStatus: number | undefined;
  try {
    const message = await (deps.complete ?? complete)(
      model,
      {
        systemPrompt: "Return one short token.",
        messages: [{ role: "user", content: "ok", timestamp: Date.now() }],
      },
      {
        apiKey: provider.getApiKey(credentials),
        maxTokens: 1,
        onResponse: (response) => {
          responseStatus = response.status;
        },
      },
    );
    if (copilotHasNoModels) {
      return {
        eligibility: "plan_ineligible",
        servedModelIds: [],
        detail: "No models are available for this Copilot plan.",
      };
    }
    // pi-ai transports surface HTTP failures as stopReason "error" instead of
    // rejecting complete(), so billing classification must run here too.
    if (message.stopReason === "error") return classifyFailure(responseStatus);
    return { eligibility: "eligible", servedModelIds };
  } catch (error) {
    return classifyFailure(responseStatus ?? errorStatus(error));
  }
}

/**
 * Only a confirmed billing refusal may mark a plan ineligible; auth failures,
 * server errors, and network outages stay "unknown" so a transient outage
 * never persists a false eligibility verdict.
 */
function classifyFailure(responseStatus: number | undefined): CapabilityProbeResult {
  if (responseStatus === 402) {
    return {
      eligibility: "plan_ineligible",
      servedModelIds: [],
      detail: "Provider plan does not cover the probe model.",
    };
  }
  return unknown(
    responseStatus === undefined
      ? "Capability probe request failed."
      : `Capability probe failed with HTTP ${responseStatus}.`,
  );
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function selectProbeModel(
  id: ConnectedProviderId,
  available: Model<Api>[],
): Model<Api> | undefined {
  if (id === "openai-codex") {
    const donor = available.find((model) => model.id === "gpt-5.4-mini") ?? available[0];
    return donor
      ? { ...donor, id: CHATGPT_PROBE_MODEL_ID, name: CHATGPT_PROBE_MODEL_ID }
      : undefined;
  }
  return available.reduce<Model<Api> | undefined>((cheapest, model) => {
    if (!cheapest) return model;
    return model.cost.input + model.cost.output < cheapest.cost.input + cheapest.cost.output
      ? model
      : cheapest;
  }, undefined);
}

function hasEmptyAvailableModelIds(credentials: OAuthCredentials): boolean {
  return Array.isArray(credentials.availableModelIds) && credentials.availableModelIds.length === 0;
}

function unknown(detail: string): CapabilityProbeResult {
  return { eligibility: "unknown", servedModelIds: [], detail };
}
