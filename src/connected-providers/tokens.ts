import { refreshConnectedCredentials } from "./refresh.js";
import { connectedProviders } from "./registry.js";
import {
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectedProviderStore,
  type ConnectionRecord,
  type OAuthCredentials,
} from "./store.js";

const REFRESH_SKEW_MS = 60_000;

export interface ConnectedTokenManager {
  /** Load the process-lifetime connection snapshot and seed every still-valid access token. */
  loadSnapshot(): Promise<readonly ConnectionRecord[]>;
  /** Refresh all usable providers discovered by the boot snapshot. */
  ensureFreshTokens(): Promise<void>;
  /** Return a fresh token, coalescing concurrent refreshes for this provider. */
  ensureFreshToken(provider: ConnectedProviderId): Promise<string | undefined>;
  /** Synchronously read a usable access token from the in-process cache. */
  apiKey(provider: ConnectedProviderId): string | undefined;
  /** Start a coalesced refresh without making a synchronous caller wait. */
  refreshInBackground(provider: ConnectedProviderId): void;
  /** Synchronously read the cached full credential set for a provider. */
  credentials(provider: ConnectedProviderId): OAuthCredentials | undefined;
}

interface ConnectedTokenManagerOptions {
  /** Durable source of credentials and cross-process refresh serialization. */
  store: ConnectedProviderStore;
  /** Clock used for independent provider expiry decisions. */
  now?: () => number;
  /** Provider refresh edge, injectable so tests never call live OAuth issuers. */
  refreshCredentials?: (
    provider: ConnectedProviderId,
    credentials: OAuthCredentials,
  ) => Promise<OAuthCredentials>;
}

/** Build an isolated token cache around a connected-provider store. */
export function createConnectedTokenManager(
  options: ConnectedTokenManagerOptions,
): ConnectedTokenManager {
  const now = options.now ?? Date.now;
  const refreshCredentials = options.refreshCredentials ?? refreshConnectedCredentials;
  const cache = new Map<ConnectedProviderId, OAuthCredentials>();
  const refreshes = new Map<ConnectedProviderId, Promise<string | undefined>>();
  let bootConnections: readonly ConnectionRecord[] = [];

  const isFresh = (credentials: OAuthCredentials): boolean =>
    credentials.expires > now() + REFRESH_SKEW_MS;

  const ensureFreshToken = (provider: ConnectedProviderId): Promise<string | undefined> => {
    const cached = cache.get(provider);
    if (cached && isFresh(cached)) return Promise.resolve(cached.access);
    const active = refreshes.get(provider);
    if (active) return active;

    const pending = options.store
      .withLock(provider, async (current) => {
        if (!current) return { result: undefined };
        if (isFresh(current.credentials)) {
          return { next: current, result: current.credentials };
        }
        const credentials = await refreshCredentials(provider, current.credentials);
        const next: ConnectionRecord = { ...current, credentials, lastRefreshAt: now() };
        return { next, result: credentials };
      })
      .then((credentials) => {
        if (!credentials) {
          cache.delete(provider);
          return undefined;
        }
        cache.set(provider, credentials);
        return credentials.access;
      })
      .finally(() => {
        if (refreshes.get(provider) === pending) refreshes.delete(provider);
      });
    refreshes.set(provider, pending);
    return pending;
  };

  return {
    async loadSnapshot() {
      bootConnections = await options.store.read();
      cache.clear();
      for (const connection of bootConnections) {
        if (isFresh(connection.credentials)) cache.set(connection.provider, connection.credentials);
      }
      return bootConnections;
    },
    async ensureFreshTokens() {
      await Promise.all(
        bootConnections
          .filter(({ eligibility }) => eligibility !== "plan_ineligible")
          // A failed issuer refresh leaves this provider uncached. Synchronous
          // model resolution then keeps the call on router order instead of
          // making CLI turn startup fail before fallback can apply.
          .map(({ provider }) => ensureFreshToken(provider).catch(() => undefined)),
      );
    },
    ensureFreshToken,
    apiKey(provider) {
      const credentials = cache.get(provider);
      if (!credentials || !isFresh(credentials)) return undefined;
      return credentials.access;
    },
    refreshInBackground(provider) {
      void ensureFreshToken(provider).catch(() => undefined);
    },
    credentials(provider) {
      return cache.get(provider);
    },
  };
}

const connectedTokens = createConnectedTokenManager({ store: createConnectedProviderStore() });

/**
 * Run the provider's OAuth model hook against a resolved spec. Copilot
 * credentials rewrite the endpoint for Enterprise accounts and filter models
 * the account cannot serve; returns undefined when the account filters the
 * model out, and the unhooked spec when no credentials are loaded.
 */
export function applyConnectedModelHook<T extends { id: string }>(
  provider: ConnectedProviderId,
  model: T,
): T | undefined {
  const credentials = connectedTokens.credentials(provider);
  if (!credentials) return model;
  const oauth = connectedProviders()
    .find((entry) => entry.id === provider)
    ?.oauth();
  if (!oauth?.modifyModels) return model;
  const kept = oauth.modifyModels([model as never], credentials) as unknown as T[];
  return kept.find((entry) => entry.id === model.id);
}

export function loadConnectedTokensSnapshot(): Promise<readonly ConnectionRecord[]> {
  return connectedTokens.loadSnapshot();
}

export function ensureFreshConnectedTokens(): Promise<void> {
  return connectedTokens.ensureFreshTokens();
}

export function connectedProviderApiKey(provider: ConnectedProviderId): string | undefined {
  return connectedTokens.apiKey(provider);
}

export function refreshConnectedTokenInBackground(provider: ConnectedProviderId): void {
  connectedTokens.refreshInBackground(provider);
}
