import { getOAuthProvider, type OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";
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
  oauth(): OAuthProviderInterface;
}

function oauthProvider(id: ConnectedProviderId): OAuthProviderInterface {
  const provider = getOAuthProvider(id);
  if (!provider) throw new Error(`OAuth provider is not registered: ${id}`);
  return provider;
}

const CONNECTED_PROVIDERS: readonly ConnectedProviderEntry[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    alias: "chatgpt",
    loginModes: ["device_code", "browser"],
    oauth: () => oauthProvider("openai-codex"),
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    alias: "copilot",
    loginModes: ["device_code"],
    oauth: () => oauthProvider("github-copilot"),
  },
];

export function connectedProviders(): readonly ConnectedProviderEntry[] {
  return CONNECTED_PROVIDERS;
}

export function resolveConnectedProviderAlias(input: string): ConnectedProviderId | undefined {
  return CONNECTED_PROVIDERS.find(({ id, alias }) => input === id || input === alias)?.id;
}
