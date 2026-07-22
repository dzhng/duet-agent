import type { Usage } from "@earendil-works/pi-ai";
import type { TransportName } from "../model-resolution/catalog.js";
import type { TurnTokenUsage } from "../types/protocol.js";
import { isConnectedProviderId } from "./store.js";

/** Return provider usage with subscription-covered prices forced to zero. */
export function usageForTransport(
  usage: TurnTokenUsage | Usage,
  provider: TransportName,
): TurnTokenUsage | Usage {
  if (!isConnectedProviderId(provider)) return usage;
  return {
    ...usage,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
