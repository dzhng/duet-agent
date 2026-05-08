import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type AddressInfo, createServer } from "node:net";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolveDuetAppBaseUrl } from "./duet-app-url.js";

/**
 * Browser-based login bootstrap for the duet CLI.
 *
 * 1. Pick a free localhost port and start an ephemeral HTTP server on
 *    `/callback`.
 * 2. Generate a CSRF state, open the browser to
 *    `<app>/cli/login?port=<n>&state=<s>`.
 * 3. Wait for the user to confirm in the browser; the app redirects them
 *    to `http://127.0.0.1:<n>/callback?code=...&state=...`.
 * 4. Validate state, POST `<app>/api/v1/cli/exchange` with `{ code, state }`,
 *    return the resulting `{ apiKey, orgSlug, orgName, appUrl }`.
 *
 * The server is single-shot — it shuts down after responding to one
 * `/callback` request (or on timeout).
 */

export interface LoginResult {
  apiKey: string;
  orgSlug: string;
  orgName: string;
  appUrl: string;
}

export interface LoginOptions {
  appBaseUrl?: string;
  /** Print the auth URL instead of opening a browser. */
  noBrowser?: boolean;
  /** Hard cap on how long we'll wait for the browser callback. */
  timeoutMs?: number;
  /** Inject HTTP for the exchange call (testing). */
  fetchFn?: typeof fetch;
  /** Override how the URL is opened (testing). */
  openUrl?: (url: string) => void;
  /** Stream user-facing progress (default: stderr). */
  log?: (message: string) => void;
}

export async function loginWithBrowser(options: LoginOptions = {}): Promise<LoginResult> {
  const appBaseUrl = options.appBaseUrl ?? resolveDuetAppBaseUrl();
  const fetchFn = options.fetchFn ?? fetch;
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  const port = await findFreePort();
  const state = randomBytes(24).toString("base64url");
  const loginUrl = `${appBaseUrl}/cli/login?port=${port}&state=${encodeURIComponent(state)}`;

  log(`Open this URL to authorize the duet CLI:\n  ${loginUrl}`);

  const callbackPromise = waitForCallback({ port, expectedState: state, timeoutMs });

  if (!options.noBrowser) {
    try {
      (options.openUrl ?? openInBrowser)(loginUrl);
    } catch (err) {
      log(
        `Could not open the browser automatically (${err instanceof Error ? err.message : err}). Open the URL manually.`,
      );
    }
  }

  const code = await callbackPromise;

  log("Exchanging authorization code...");
  const response = await fetchFn(`${appBaseUrl}/api/v1/cli/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(
      `Exchange failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 256)}` : ""}`,
    );
  }

  const body = (await response.json()) as Partial<LoginResult>;
  if (
    !body ||
    typeof body.apiKey !== "string" ||
    typeof body.orgSlug !== "string" ||
    typeof body.orgName !== "string" ||
    typeof body.appUrl !== "string"
  ) {
    throw new Error("Unexpected exchange response shape");
  }
  return {
    apiKey: body.apiKey,
    orgSlug: body.orgSlug,
    orgName: body.orgName,
    appUrl: body.appUrl,
  };
}

interface CallbackOptions {
  port: number;
  expectedState: string;
  timeoutMs: number;
}

function waitForCallback({ port, expectedState, timeoutMs }: CallbackOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      handleCallback(req, res, expectedState, (err, code) => {
        if (err || !code) {
          server.close();
          reject(err ?? new Error("Callback received without a code"));
          return;
        }
        server.close();
        resolve(code);
      });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out waiting for browser confirmation after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    server.once("close", () => clearTimeout(timer));

    server.listen(port, "127.0.0.1");
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  expectedState: string,
  done: (err: Error | null, code?: string) => void,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const receivedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    respondError(res, "Authorization rejected. You can close this tab.");
    done(new Error(`Authorization error: ${error}`));
    return;
  }
  if (!code || !receivedState) {
    respondError(res, "Missing code or state. You can close this tab.");
    done(new Error("Missing code or state in callback"));
    return;
  }
  if (receivedState !== expectedState) {
    respondError(res, "State mismatch. You can close this tab.");
    done(new Error("State mismatch — refusing to exchange code"));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><meta charset="utf-8"><title>duet CLI</title>` +
      `<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center">` +
      `<h1 style="margin-bottom:8px">duet CLI authorized</h1>` +
      `<p style="color:#646565">You can close this tab and return to your terminal.</p>` +
      `</body>`,
  );
  done(null, code);
}

function respondError(res: ServerResponse, message: string): void {
  res.statusCode = 400;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new Error("Failed to allocate a localhost port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.unref();
  child.on("error", () => {
    /* swallow — caller logs and tells the user to open manually */
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
