import {
  PROVIDER_ORDER,
  transportModelId,
  type TransportName,
} from "../model-resolution/catalog.js";
import { CONNECTED_PROVIDER_ORDER, isConnectedProviderId, type ConnectionRecord } from "./store.js";

export interface TransportSnapshot {
  /** Connections present when the CLI process booted; later store edits apply on the next invocation. */
  connections: readonly Pick<ConnectionRecord, "provider" | "eligibility">[];
}

export interface TransportChoice {
  /** Backend selected to carry the requested model. */
  transport: TransportName;
  /** Provider-specific model id sent on the selected transport. */
  modelId: string;
  /** True when a connected subscription, rather than a metered router, carries the call. */
  planCovered: boolean;
  /** Rule that selected this transport. */
  reason: "connected" | "router_order" | "explicit_pin";
}

/** Choose a transport from an immutable boot snapshot without reading env or disk. */
export function chooseTransport(shorthand: string, snapshot: TransportSnapshot): TransportChoice {
  const separator = shorthand.indexOf(":");
  if (separator !== -1) {
    const transport = shorthand.slice(0, separator) as TransportName;
    return {
      transport,
      modelId: shorthand.slice(separator + 1),
      planCovered: isConnectedProviderId(transport),
      reason: "explicit_pin",
    };
  }

  for (const provider of CONNECTED_PROVIDER_ORDER) {
    const connection = snapshot.connections.find((candidate) => candidate.provider === provider);
    if (!connection || connection.eligibility === "plan_ineligible") continue;
    const modelId = transportModelId(provider, shorthand);
    if (modelId) {
      return { transport: provider, modelId, planCovered: true, reason: "connected" };
    }
  }

  for (const { provider } of PROVIDER_ORDER) {
    const modelId = transportModelId(provider, shorthand);
    if (modelId) {
      return { transport: provider, modelId, planCovered: false, reason: "router_order" };
    }
  }

  // Unknown names retain resolver.ts's pass-through behavior until it can
  // produce the existing user-facing "Unknown model shorthand" error.
  return {
    transport: PROVIDER_ORDER[0]!.provider,
    modelId: shorthand,
    planCovered: false,
    reason: "router_order",
  };
}
