import { describe, expect, test } from "bun:test";
import {
  createEmbeddingClient,
  EMBEDDING_BATCH_LIMIT,
  DEFAULT_DUET_EMBEDDING_MODEL,
  EmbeddingUnavailableError,
} from "../src/memory/embedding.js";

describe("Embedding client", () => {
  test("posts model and inputs to the gateway embeddings endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    let capturedAuth = "";
    const fetchStub = (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        model: "google/gemini-embedding-2",
      });
    }) as unknown as typeof fetch;
    const embed = createEmbeddingClient({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      fetch: fetchStub,
    });

    const result = await embed(["alpha", "beta"]);

    expect(result).toEqual({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: "google/gemini-embedding-2",
    });
    expect(capturedUrl).toBe("https://example.test/v1/embeddings");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(capturedBody).toEqual({
      model: DEFAULT_DUET_EMBEDDING_MODEL,
      input: ["alpha", "beta"],
    });
  });

  test("honors DUET_EMBEDDING_MODEL for the requested model", async () => {
    const previous = process.env.DUET_EMBEDDING_MODEL;
    process.env.DUET_EMBEDDING_MODEL = "openai/text-embedding-3-small";
    let capturedBody: unknown = null;
    const fetchStub = (async (_input: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ data: [{ embedding: [1] }], model: "openai/text-embedding-3-small" });
    }) as unknown as typeof fetch;

    try {
      const embed = createEmbeddingClient({
        apiKey: "k",
        baseUrl: "https://example.test",
        fetch: fetchStub,
      });
      await embed(["alpha"]);
    } finally {
      if (previous === undefined) delete process.env.DUET_EMBEDDING_MODEL;
      else process.env.DUET_EMBEDDING_MODEL = previous;
    }

    expect(capturedBody).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["alpha"],
    });
  });

  test("splits oversized requests into multiple HTTP calls", async () => {
    const calls: string[][] = [];
    const fetchStub = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(body.input);
      // Echo: each input becomes a one-element vector with its length.
      return jsonResponse({
        data: body.input.map((value) => ({ embedding: [value.length] })),
        model: "google/gemini-embedding-2",
      });
    }) as unknown as typeof fetch;
    const embed = createEmbeddingClient({ apiKey: "k", fetch: fetchStub });

    const inputs = Array.from({ length: EMBEDDING_BATCH_LIMIT + 5 }, (_, index) => `t${index}`);
    const result = await embed(inputs);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(EMBEDDING_BATCH_LIMIT);
    expect(calls[1]).toHaveLength(5);
    expect(result.embeddings).toHaveLength(inputs.length);
    expect(result.model).toBe("google/gemini-embedding-2");
  });

  test("throws EmbeddingUnavailableError when the API key is missing", async () => {
    const embed = createEmbeddingClient({
      apiKey: () => undefined,
      fetch: (() => never()) as unknown as typeof fetch,
    });
    await expect(embed(["anything"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  test("fails fast on 4xx responses without retrying", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    const embed = createEmbeddingClient({ apiKey: "k", fetch: fetchStub });

    await expect(embed(["anything"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    // Single request: retrying a 403 will not flip to a 200, so the
    // client surfaces the error immediately rather than wasting time.
    expect(calls).toBe(1);
  });

  test("retries 5xx responses with backoff and eventually succeeds", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      if (calls < 3) return new Response("oops", { status: 503 });
      return jsonResponse({
        data: [{ embedding: [1, 2, 3] }],
        model: "google/gemini-embedding-2",
      });
    }) as unknown as typeof fetch;
    const embed = createEmbeddingClient({ apiKey: "k", fetch: fetchStub });

    const result = await embed(["recovers"]);
    expect(result.embeddings).toEqual([[1, 2, 3]]);
    expect(result.model).toBe("google/gemini-embedding-2");
    expect(calls).toBe(3);
  });

  test("rejects OpenAI-compatible responses with the wrong vector count", async () => {
    const fetchStub = (async () =>
      jsonResponse({
        data: [{ embedding: [1] }],
        model: "google/gemini-embedding-2",
      })) as unknown as typeof fetch;
    const embed = createEmbeddingClient({ apiKey: "k", fetch: fetchStub });

    await expect(embed(["a", "b"])).rejects.toThrow(/did not match request size/);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function never(): never {
  throw new Error("fetch should not have been called");
}
