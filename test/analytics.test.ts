import { describe, expect } from "bun:test";
import { captureCliEvent } from "../src/lib/analytics.js";
import { testIfDocker } from "./helpers/docker-only.js";

interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetch(handler: (request: FakeRequest) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: FakeRequest[];
} {
  const calls: FakeRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const entries =
        rawHeaders instanceof Headers
          ? Array.from(rawHeaders.entries())
          : Array.isArray(rawHeaders)
            ? rawHeaders
            : Object.entries(rawHeaders);
      for (const [k, v] of entries) headers[k] = String(v);
    }
    const request: FakeRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(request);
    return await handler(request);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("captureCliEvent", () => {
  testIfDocker("posts the event to /api/v1/analytics/events with bearer auth", async () => {
    const { fetchFn, calls } = makeFetch(
      () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    await captureCliEvent({
      apiKey: "duet_gt_x",
      name: "cli_login",
      appBaseUrl: "https://test",
      fetchFn,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://test/api/v1/analytics/events");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization ?? call.headers.Authorization).toBe("Bearer duet_gt_x");
    expect(JSON.parse(call.body)).toEqual({ name: "cli_login" });
  });

  testIfDocker("logs a warning on non-2xx but does not throw", async () => {
    const { fetchFn } = makeFetch(
      () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    const logged: string[] = [];

    await captureCliEvent({
      apiKey: "duet_gt_x",
      name: "cli_login",
      appBaseUrl: "https://test",
      fetchFn,
      logger: (m) => logged.push(m),
    });

    expect(logged.some((line) => line.includes("401") && line.includes("cli_login"))).toBe(true);
  });

  testIfDocker("swallows network errors and logs them", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const logged: string[] = [];

    await captureCliEvent({
      apiKey: "duet_gt_x",
      name: "cli_login",
      appBaseUrl: "https://test",
      fetchFn,
      logger: (m) => logged.push(m),
    });

    expect(logged.some((line) => line.includes("network down"))).toBe(true);
  });

  testIfDocker("stays silent when no logger is provided and the call fails", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    // No throw, no observable output.
    await captureCliEvent({
      apiKey: "duet_gt_x",
      name: "cli_login",
      appBaseUrl: "https://test",
      fetchFn,
    });
  });
});
