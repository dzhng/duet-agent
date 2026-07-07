import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DUET_AGENT_FEEDBACK_SOURCE, submitDuetFeedback } from "../src/lib/feedback.js";

let originalBaseUrl: string | undefined;

beforeEach(() => {
  originalBaseUrl = process.env.DUET_API_BASE_URL;
  process.env.DUET_API_BASE_URL = "https://test";
});

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.DUET_API_BASE_URL;
  else process.env.DUET_API_BASE_URL = originalBaseUrl;
});

describe("submitDuetFeedback", () => {
  test("POSTs trimmed content with the duet-agent-cli source by default", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await submitDuetFeedback({
      content: "  the TUI flickers when resuming  ",
      fetch: fetchImpl,
    });

    expect(result.baseUrl).toBe("https://test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://test/v1/feedback");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      content: "the TUI flickers when resuming",
      source: DUET_AGENT_FEEDBACK_SOURCE,
    });
  });

  test("rejects when content is empty after trimming", async () => {
    const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await expect(submitDuetFeedback({ content: "   \n  ", fetch: fetchImpl })).rejects.toThrow(
      "Feedback content is required",
    );
  });

  test("throws on non-2xx with the response status and body", async () => {
    const fetchImpl = (async () =>
      new Response("server boom", { status: 500 })) as unknown as typeof fetch;
    await expect(submitDuetFeedback({ content: "broken", fetch: fetchImpl })).rejects.toThrow(
      "Feedback submission failed (500): server boom",
    );
  });
});
