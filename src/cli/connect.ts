import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { printConnectHelp } from "./help.js";
import { usageError } from "./shared.js";
import {
  probeConnectedProvider,
  type CapabilityProbeResult,
} from "../connected-providers/capability-probe.js";
import { installFakeIssuerIfConfigured } from "../connected-providers/fake-issuer.js";
import {
  connectedProviders,
  resolveConnectedProviderAlias,
} from "../connected-providers/registry.js";
import {
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectedProviderStore,
  type ConnectionRecord,
} from "../connected-providers/store.js";

export interface ConnectCommandIO {
  /** Credential-store seam used by the CLI and replaced with an in-memory store in tests. */
  store?: ConnectedProviderStore;
  /** Write human output or protocol-only JSON to stdout. */
  write?: (text: string) => void;
  /** Write human progress to stderr, independently capturable from protocol stdout. */
  writeError?: (text: string) => void;
  /** Override the help printer without intercepting global stdout. */
  printHelp?: () => void;
  /** Environment seam that gates fake-issuer registration in tests and staging. */
  env?: Record<string, string | undefined>;
  /** Override TTY detection; non-interactive calls always use device-code login. */
  interactive?: boolean;
  /** Override browser launch without changing which OAuth flow runs. */
  openUrl?: (url: string) => void;
  /** Read browser-flow fallback input or Copilot enterprise-domain input. */
  prompt?: (message: string) => Promise<string>;
  /** Capability seam; production performs a real one-token provider completion. */
  probe?: typeof probeConnectedProvider;
  /** Clock used for persisted timestamps and device-code expiry events. */
  now?: () => number;
}

type ConnectionStatusJson = Pick<
  ConnectionRecord,
  "provider" | "connectedAt" | "eligibility" | "eligibilityCheckedAt" | "lastRefreshAt"
>;

export type ConnectedProviderCliEvent =
  | {
      type: "device_code";
      provider: ConnectedProviderId;
      verificationUri: string;
      userCode: string;
      expiresAt: number;
    }
  | { type: "progress"; provider: ConnectedProviderId; code: string }
  | {
      type: "complete";
      provider: ConnectedProviderId;
      state: "connected" | "plan_ineligible" | "disconnected";
    }
  | { type: "error"; provider: ConnectedProviderId; code: string };

export async function runConnectCommand(args: string[], io: ConnectCommandIO = {}): Promise<void> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const writeError = io.writeError ?? ((text: string) => process.stderr.write(text));
  const store = io.store ?? createConnectedProviderStore();
  let status = false;
  let json = false;
  let deviceCode = false;
  let noBrowser = false;
  let disconnect: ConnectedProviderId | undefined;
  let target: ConnectedProviderId | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--status":
        status = true;
        break;
      case "--json":
        json = true;
        break;
      case "--device-code":
        deviceCode = true;
        break;
      case "--no-browser":
        noBrowser = true;
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
        if (arg.startsWith("-")) usageError(`Unknown connect option: ${arg}`);
        if (target !== undefined) usageError(`Unexpected connect argument: ${arg}`);
        target = resolveProvider(arg);
    }
  }

  if (!status && disconnect === undefined && target === undefined) {
    if (json) usageError("--json requires --status or a provider");
    (io.printHelp ?? printConnectHelp)();
    return;
  }
  const operationCount =
    Number(status) + Number(disconnect !== undefined) + Number(target !== undefined);
  if (operationCount > 1) usageError("Choose one of provider login, --status, or --disconnect");
  if ((deviceCode || noBrowser) && target === undefined) {
    usageError("--device-code and --no-browser require a provider login");
  }

  if (disconnect !== undefined) {
    const existing = await store.get(disconnect);
    if (!existing) usageError(`${providerLabel(disconnect)} is not connected`);
    await store.remove(disconnect);
    if (json) writeEvent(write, { type: "complete", provider: disconnect, state: "disconnected" });
    else write(`Disconnected ${providerLabel(disconnect)}.\n`);
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
    return;
  }

  if (target !== undefined) {
    await connectProvider(target, {
      ...io,
      store,
      write,
      writeError,
      json,
      // --no-browser only suppresses URL auto-open; it never changes the
      // OAuth flow. Device-code mode is forced by --device-code, machine
      // output, or a non-interactive stdin.
      forceDeviceCode: deviceCode || json || !(io.interactive ?? Boolean(process.stdin.isTTY)),
      noBrowser,
    });
  }
}

function resolveProvider(value: string): ConnectedProviderId {
  return resolveConnectedProviderAlias(value) ?? usageError(`Unknown connected provider: ${value}`);
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
  return connectedProviders().find(({ id }) => id === provider)?.label ?? provider;
}

interface ConnectProviderOptions extends ConnectCommandIO {
  store: ConnectedProviderStore;
  write: (text: string) => void;
  writeError: (text: string) => void;
  json: boolean;
  forceDeviceCode: boolean;
  noBrowser: boolean;
}

async function connectProvider(
  id: ConnectedProviderId,
  options: ConnectProviderOptions,
): Promise<void> {
  installFakeIssuerIfConfigured(options.env ?? process.env);
  const entry = connectedProviders().find((candidate) => candidate.id === id);
  if (!entry) throw new Error("Connected provider is not registered.");
  const now = options.now ?? (() => Date.now());
  const emit = (event: ConnectedProviderCliEvent) => writeEvent(options.write, event);

  let credentials: ConnectionRecord["credentials"];
  try {
    credentials = await entry.oauth().login({
      onAuth: ({ url }) => {
        options.writeError(`Open ${url} to connect ${entry.label}.\n`);
        if (!options.noBrowser) openUrl(url, options.openUrl);
      },
      onDeviceCode: ({ userCode, verificationUri, expiresInSeconds }) => {
        if (options.json) {
          emit({
            type: "device_code",
            provider: id,
            verificationUri,
            userCode,
            expiresAt: now() + (expiresInSeconds ?? 900) * 1000,
          });
        } else {
          options.writeError(`User code: ${userCode}\nVerification URL: ${verificationUri}\n`);
        }
        if (!options.noBrowser && !options.json) openUrl(verificationUri, options.openUrl);
      },
      onPrompt: async ({ message, allowEmpty }) => {
        if (id === "github-copilot" && allowEmpty && !options.prompt) return "";
        return (options.prompt ?? promptInput)(message);
      },
      onProgress: () => {
        if (!options.json) options.writeError(`Connecting ${entry.label}…\n`);
      },
      onSelect: async () => (options.forceDeviceCode ? "device_code" : "browser"),
    });
  } catch (error) {
    const code = loginErrorCode(error);
    if (options.json) emit({ type: "error", provider: id, code });
    throw new Error(loginErrorMessage(code));
  }

  if (options.json) emit({ type: "progress", provider: id, code: "probing_capability" });
  else options.writeError(`Checking ${entry.label} plan eligibility…\n`);
  const result = await runProbe(options.probe ?? probeConnectedProvider, id, credentials);
  const checkedAt = now();
  await options.store.withLock(id, async () => ({
    next: {
      provider: id,
      credentials,
      connectedAt: checkedAt,
      eligibility: result.eligibility,
      eligibilityCheckedAt: checkedAt,
    },
    result: undefined,
  }));

  if (result.eligibility === "unknown") {
    if (options.json) emit({ type: "error", provider: id, code: "capability_unknown" });
    throw new Error(`${entry.label} connected, but plan eligibility could not be confirmed.`);
  }

  const state = result.eligibility === "eligible" ? "connected" : "plan_ineligible";
  if (options.json) {
    emit({ type: "complete", provider: id, state });
    return;
  }
  if (result.eligibility === "plan_ineligible") {
    options.write(`Connected ${entry.label} — plan not eligible.\n`);
    return;
  }
  const coverage = result.servedModelIds.length
    ? ` — plan covers ${result.servedModelIds.join(", ")}`
    : "";
  options.write(`Connected ${entry.label}${coverage}.\n`);
}

async function runProbe(
  probe: typeof probeConnectedProvider,
  id: ConnectedProviderId,
  credentials: ConnectionRecord["credentials"],
): Promise<CapabilityProbeResult> {
  try {
    return await probe(id, credentials);
  } catch {
    return {
      eligibility: "unknown",
      servedModelIds: [],
      detail: "Capability probe request failed.",
    };
  }
}

function writeEvent(write: (text: string) => void, event: ConnectedProviderCliEvent): void {
  write(`${JSON.stringify(event)}\n`);
}

function loginErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("denied")) return "login_denied";
  if (message.includes("expired") || message.includes("timed out")) return "login_expired";
  if (message.includes("cancel")) return "login_cancelled";
  return "login_failed";
}

function loginErrorMessage(code: string): string {
  switch (code) {
    case "login_denied":
      return "Connected-provider login was denied.";
    case "login_expired":
      return "Connected-provider device code expired.";
    case "login_cancelled":
      return "Connected-provider login was cancelled.";
    default:
      return "Connected-provider login failed.";
  }
}

function openUrl(url: string, override?: (url: string) => void): void {
  if (override) {
    override(url);
    return;
  }
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function promptInput(message: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(`${message} `);
  } finally {
    terminal.close();
  }
}
