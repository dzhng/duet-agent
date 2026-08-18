import type { OAuthAuth, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fakeConnectedProvider } from "./fake-issuer.js";
import type { ConnectedProviderId } from "./store.js";

export interface ConnectedProviderEntry {
  /** Stable transport id used by pi-ai and the credential store. */
  id: ConnectedProviderId;
  /** User-facing subscription name. */
  label: string;
  /** Short CLI value accepted by `duet connect`. */
  alias: string;
  /** Login modes this provider can run; only device code is valid in a VM. */
  loginModes: readonly ("device_code" | "browser")[];
  /** Resolve the active pi-ai implementation, including an env-gated fake issuer. */
  oauth(): OAuthAuth;
  /**
   * The whole pi-ai provider. Model availability now hangs off the provider
   * (`filterModels`) rather than the OAuth implementation, so a caller that
   * asks "which models does this account get" needs this, not just `oauth()`.
   */
  provider(): Provider;
}

/**
 * pi-ai stopped keeping a global OAuth registry: an implementation now hangs
 * off the model provider that uses it, so it is read from the built-in
 * provider list rather than looked up by id. That also makes this the one
 * place a configured fake issuer can stand in for the real one — it used to
 * overwrite the global registry from underneath every caller.
 */
function piProvider(id: ConnectedProviderId): Provider {
  const provider =
    fakeConnectedProvider(id) ?? builtinProviders().find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`OAuth provider is not registered: ${id}`);
  return provider;
}

function oauthProvider(id: ConnectedProviderId): OAuthAuth {
  const oauth = piProvider(id).auth.oauth;
  if (!oauth) throw new Error(`OAuth provider is not registered: ${id}`);
  return oauth;
}

const CONNECTED_PROVIDERS: readonly ConnectedProviderEntry[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    alias: "chatgpt",
    loginModes: ["device_code", "browser"],
    oauth: () => oauthProvider("openai-codex"),
    provider: () => piProvider("openai-codex"),
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    alias: "copilot",
    loginModes: ["device_code"],
    oauth: () => oauthProvider("github-copilot"),
    provider: () => piProvider("github-copilot"),
  },
];

export function connectedProviders(): readonly ConnectedProviderEntry[] {
  return CONNECTED_PROVIDERS;
}

export function resolveConnectedProviderAlias(input: string): ConnectedProviderId | undefined {
  return CONNECTED_PROVIDERS.find(({ id, alias }) => input === id || input === alias)?.id;
}
