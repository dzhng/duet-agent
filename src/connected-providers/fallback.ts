import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  chooseTransport,
  type TransportChoice,
  type TransportSnapshot,
} from "./transport-preference.js";
import { shorthandForTransportModel } from "../model-resolution/catalog.js";
import { isConnectedProviderId, type ConnectedProviderId } from "./store.js";
import type { TransportFallbackCause } from "./fallback-notice.js";

/** Classify only failures eligible for cross-transport fallback. */
export function connectedFallbackCause(
  message: AgentMessage | undefined,
): TransportFallbackCause | undefined {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
  const error = message.errorMessage ?? "";
  if (/context|prompt is too long|token.*maximum/i.test(error)) return undefined;
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*(?:token|key)|authentication/i.test(error)) {
    return "auth_failed";
  }
  if (/\b402\b|\b429\b|usage limit|plan limit|quota|exhausted|not included/i.test(error)) {
    return "plan_exhausted";
  }
  return "transport_error";
}

/** True when a connected failure must terminate because replay is no longer safe. */
export function isPostOutputConnectedFailure(
  provider: string,
  message: AgentMessage | undefined,
  visibleOutput: boolean,
): boolean {
  return (
    visibleOutput &&
    isConnectedProviderId(provider) &&
    connectedFallbackCause(message) !== undefined
  );
}

/** Select the next transport after treating the failed connection as ineligible. */
export function nextTransportAfterConnectedFailure(
  provider: ConnectedProviderId,
  modelId: string,
  snapshot: TransportSnapshot,
): TransportChoice | undefined {
  const shorthand = shorthandForTransportModel(provider, modelId);
  if (!shorthand) return undefined;
  const connections = snapshot.connections.some((connection) => connection.provider === provider)
    ? snapshot.connections.map((connection) =>
        connection.provider === provider
          ? { ...connection, eligibility: "plan_ineligible" as const }
          : connection,
      )
    : [...snapshot.connections, { provider, eligibility: "plan_ineligible" as const }];
  return chooseTransport(shorthand, { connections });
}
