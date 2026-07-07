import { spawn } from "node:child_process";
import { resolveDuetApiBaseUrl } from "./duet-api-url.js";

/**
 * Device-code login bootstrap for the duet CLI.
 *
 * 1. Request a device code from `POST <api>/v1/device/code` with the selected
 *    workspace-scoped AI capability.
 * 2. Print the server-supplied user code and verification URI, opening the URI
 *    in a browser unless `--no-browser` was set.
 * 3. Poll `POST <api>/v1/device/token` at the server interval until the user
 *    approves, denies, or the code expires.
 * 4. Return the approved `DUET_API_KEY` plus workspace info for persistence.
 */

export interface LoginResult {
  apiKey: string;
  workspaceSlug: string;
  workspaceName: string;
}

export interface LoginOptions {
  /**
   * Workspace slug used to request a one-workspace token. The CLI requires it
   * before starting login because every generated `DUET_API_KEY` is scoped to
   * exactly one workspace.
   */
  workspaceSlug: string;
  /** Override the Duet API base URL; defaults to `DUET_API_BASE_URL` or production. */
  apiBaseUrl?: string;
  /** Print the verification URL instead of opening a browser. */
  noBrowser?: boolean;
  /** Inject HTTP for the device-code and polling calls (testing). */
  fetchFn?: typeof fetch;
  /** Override how the verification URL is opened (testing). */
  openUrl?: (url: string) => void;
  /** Override polling sleep (testing). */
  sleep?: (ms: number) => Promise<void>;
  /** Stream user-facing progress (default: stderr). */
  log?: (message: string) => void;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  status: "pending" | "approved" | "denied" | "expired" | "slow_down" | string;
  access_token?: string;
  interval?: number;
  workspace?: { slug?: string; name?: string };
  workspace_slug?: string;
  workspace_name?: string;
}

export async function loginWithDeviceFlow(options: LoginOptions): Promise<LoginResult> {
  const apiBaseUrl = options.apiBaseUrl ?? resolveDuetApiBaseUrl();
  const fetchFn = options.fetchFn ?? fetch;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const code = await postJson<DeviceCodeResponse>(fetchFn, `${apiBaseUrl}/v1/device/code`, {
    scopes: [`ws:${options.workspaceSlug}:ai`],
  });

  log(`User code: ${code.user_code}`);
  log(`Verification URL: ${code.verification_uri}`);

  if (!options.noBrowser) {
    try {
      (options.openUrl ?? openInBrowser)(code.verification_uri);
    } catch (err) {
      log(
        `Could not open the browser automatically (${err instanceof Error ? err.message : err}). Open the URL manually.`,
      );
    }
  }

  let intervalMs = Math.max(1, Number(code.interval || 5)) * 1000;
  while (true) {
    const token = await postJson<DeviceTokenResponse>(fetchFn, `${apiBaseUrl}/v1/device/token`, {
      device_code: code.device_code,
    });

    if (token.status === "approved") {
      if (typeof token.access_token !== "string" || !token.access_token) {
        throw new Error("Device token response was malformed.");
      }
      const workspaceSlug = token.workspace?.slug ?? token.workspace_slug ?? options.workspaceSlug;
      const workspaceName = token.workspace?.name ?? token.workspace_name ?? workspaceSlug;
      return {
        apiKey: token.access_token,
        workspaceSlug,
        workspaceName,
      };
    }

    if (token.status === "pending") {
      await sleep(intervalMs);
      continue;
    }

    if (token.status === "slow_down") {
      intervalMs = Math.max(intervalMs + 5_000, Number(token.interval ?? 10) * 1000);
      await sleep(intervalMs);
      continue;
    }

    if (token.status === "denied") throw new Error("Device login denied.");
    if (token.status === "expired")
      throw new Error("Device login expired. Run `duet login` again.");

    throw new Error(`Device login ended with status: ${token.status}`);
  }
}

async function postJson<T>(fetchFn: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(
      `Device login request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 256)}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.unref();
  child.on("error", () => {
    /* caller logs and tells the user to open manually */
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
