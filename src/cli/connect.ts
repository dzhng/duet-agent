import { printConnectHelp } from "./help.js";
import { usageError } from "./shared.js";
import {
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectedProviderStore,
  type ConnectionRecord,
} from "../connected-providers/store.js";

export interface ConnectCommandIO {
  /** Credential-store seam used by the CLI and replaced with an in-memory store in tests. */
  store?: ConnectedProviderStore;
  /** Write one complete human or JSON response to stdout. */
  write?: (text: string) => void;
  /** Override the help printer without intercepting global stdout. */
  printHelp?: () => void;
}

type ConnectionStatusJson = Pick<
  ConnectionRecord,
  "provider" | "connectedAt" | "eligibility" | "eligibilityCheckedAt" | "lastRefreshAt"
>;

/** Run the status/disconnect-only first slice of `duet connect`. */
export async function runConnectCommand(args: string[], io: ConnectCommandIO = {}): Promise<void> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const store = io.store ?? createConnectedProviderStore();
  let status = false;
  let json = false;
  let disconnect: ConnectedProviderId | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--status":
        status = true;
        break;
      case "--json":
        json = true;
        break;
      case "--disconnect": {
        const value = args[++index];
        if (!value || value.startsWith("-")) usageError("Missing value for --disconnect");
        disconnect = resolveProvider(value);
        break;
      }
      case "--help":
      case "-h":
        (io.printHelp ?? printConnectHelp)();
        return;
      default:
        usageError(`Unknown connect option: ${arg}`);
    }
  }

  if (!status && disconnect === undefined) {
    if (json) usageError("--json requires --status");
    (io.printHelp ?? printConnectHelp)();
    return;
  }
  if (status && disconnect !== undefined) {
    usageError("--status and --disconnect cannot be used together");
  }
  if (json && !status) usageError("--json requires --status");

  if (disconnect !== undefined) {
    const existing = await store.get(disconnect);
    if (!existing) usageError(`${providerLabel(disconnect)} is not connected`);
    await store.remove(disconnect);
    write(`Disconnected ${providerLabel(disconnect)}.\n`);
    return;
  }

  if (status) {
    const connections = await store.read();
    if (json) {
      write(`${JSON.stringify({ connections: connections.map(toStatusJson) })}\n`);
      return;
    }
    if (connections.length === 0) {
      write("No connected providers. Run `duet connect chatgpt`.\n");
      return;
    }
    write(`${connections.map(formatConnection).join("\n")}\n`);
  }
}

function resolveProvider(value: string): ConnectedProviderId {
  switch (value) {
    case "chatgpt":
    case "openai-codex":
      return "openai-codex";
    case "copilot":
    case "github-copilot":
      return "github-copilot";
    default:
      usageError(`Unknown connected provider: ${value}`);
  }
}

function toStatusJson(connection: ConnectionRecord): ConnectionStatusJson {
  return {
    provider: connection.provider,
    connectedAt: connection.connectedAt,
    eligibility: connection.eligibility,
    ...(connection.eligibilityCheckedAt === undefined
      ? {}
      : { eligibilityCheckedAt: connection.eligibilityCheckedAt }),
    ...(connection.lastRefreshAt === undefined ? {} : { lastRefreshAt: connection.lastRefreshAt }),
  };
}

function formatConnection(connection: ConnectionRecord): string {
  const state = connection.eligibility === "plan_ineligible" ? "plan not eligible" : "connected";
  return `${providerLabel(connection.provider)} — ${state}`;
}

function providerLabel(provider: ConnectedProviderId): string {
  return provider === "openai-codex" ? "ChatGPT" : "GitHub Copilot";
}
