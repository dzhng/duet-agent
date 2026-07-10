import { getDuetGatewayBaseUrl } from "../model-resolution/duet-gateway.js";

/**
 * Client for Duet gateway embeddings.
 *
 * Routes through the Duet model gateway (`POST <gateway>/v1/embeddings`) gated
 * by the user's existing `DUET_API_KEY`. Logged-in users get embeddings through
 * the same gateway origin as model traffic; we deliberately do not expose a way
 * to plug in a different provider key here so the runtime stays single-path.
 *
 * The requested model defaults to the current server-side embedding model and
 * can be overridden with `DUET_EMBEDDING_MODEL`. We store the model echoed by
 * the OpenAI-compatible response alongside each vector so a future model swap
 * can invalidate stale rows by tag.
 *
 * Behavior:
 *   - Inputs are batched up to `EMBEDDING_BATCH_LIMIT` per HTTP call so
 *     a single backfill batch never goes over the request body cap.
 *   - 5xx responses, 429 rate limits, and network errors retry with
 *     exponential backoff; other 4xx responses (auth, malformed) fail
 *     fast since retrying will not change the outcome.
 *   - When `DUET_API_KEY` is missing the function throws a typed error
 *     so callers can degrade to keyword-only retrieval (the recall_memory
 *     tool catches it and logs once; the backfill worker logs and
 *     sleeps until the user logs in).
 */

/** Embedding dimensions expected by the pgvector column. */
export const EMBEDDING_DIMENSIONS = 3072;
/** Maximum input strings sent in a single embedding request. */
export const EMBEDDING_BATCH_LIMIT = 100;
/** Current Duet embedding default; matches the 3072-dim pgvector table. */
export const DEFAULT_DUET_EMBEDDING_MODEL = "google/gemini-embedding-2";
export const DUET_EMBEDDING_MODEL_ENV = "DUET_EMBEDDING_MODEL";

const ENDPOINT_PATH = "/v1/embeddings";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Result of an `EmbedFn` call. `model` is the identifier the server
 * reported alongside the vectors; storage tags each row with it so a
 * later model swap can invalidate stale rows by string match.
 */
export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

/**
 * Callable shape consumed by the backfill worker and the recall_memory
 * tool. Inputs map 1:1 to `embeddings`.
 */
export type EmbedFn = (inputs: string[]) => Promise<EmbedResult>;

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface CreateEmbeddingClientOptions {
  /**
   * Override the API key resolver. Defaults to reading `DUET_API_KEY`
   * from `process.env`. Tests inject a fixed value to exercise the
   * client without touching environment state.
   */
  apiKey?: string | (() => string | undefined);
  /**
   * Override the gateway base URL. Defaults to `getDuetGatewayBaseUrl()` so
   * embeddings follow the same staging/production routing as model traffic.
   */
  baseUrl?: string;
  /**
   * Override the requested embedding model. Defaults to
   * `DUET_EMBEDDING_MODEL`, then `DEFAULT_DUET_EMBEDDING_MODEL`.
   */
  model?: string;
  /**
   * Override the fetch implementation. Tests use this to assert request
   * shape and stub responses without standing up a real server.
   */
  fetch?: typeof fetch;
}

/**
 * Build an `EmbedFn` bound to the Duet embedding endpoint. Constructed
 * once per process and reused for every backfill batch and every
 * `recall_memory` query so connection reuse can amortize TLS setup.
 */
export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbedFn {
  const baseUrl = options.baseUrl ?? getDuetGatewayBaseUrl();
  const requestedModel = options.model ?? resolveEmbeddingModel();
  const fetchImpl = options.fetch ?? fetch;

  return async (inputs) => {
    if (inputs.length === 0) return { embeddings: [], model: "" };
    const apiKey = resolveApiKey(options.apiKey);
    if (!apiKey) {
      // Throwing a typed error lets callers branch on graceful
      // degradation without string-matching the message.
      throw new EmbeddingUnavailableError(
        "DUET_API_KEY is not set; embeddings unavailable. Run `duet login` to enable hybrid memory retrieval.",
      );
    }

    const embeddings: number[][] = [];
    let responseModel = "";
    for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_LIMIT) {
      const slice = inputs.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
      const batch = await postBatch({
        url: `${baseUrl}${ENDPOINT_PATH}`,
        apiKey,
        model: requestedModel,
        inputs: slice,
        fetchImpl,
      });
      if (batch.embeddings.length !== slice.length) {
        throw new Error(
          `Embedding response length (${batch.embeddings.length}) did not match request size (${slice.length})`,
        );
      }
      embeddings.push(...batch.embeddings);
      // The server returns the same model on every batch within a call.
      // Take the last one so the caller sees what the server most
      // recently agreed to; mid-call mismatches are not a thing we
      // currently need to reconcile.
      responseModel = batch.model;
    }
    return { embeddings, model: responseModel };
  };
}

interface PostBatchOptions {
  url: string;
  apiKey: string;
  model: string;
  inputs: string[];
  fetchImpl: typeof fetch;
}

async function postBatch(options: PostBatchOptions): Promise<EmbedResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: options.model, input: options.inputs }),
      });

      if (response.ok) {
        const body = (await response.json()) as EmbeddingResponseEnvelope;
        return { embeddings: body.data.map((entry) => entry.embedding), model: body.model };
      }

      // 4xx errors (auth, malformed input) will not improve on retry;
      // surface them immediately so callers see the real cause. 429 is
      // the exception: a rate limit clears on its own, so it falls
      // through to the same backoff-and-retry path as 5xx.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const detail = await safeReadText(response);
        throw new EmbeddingUnavailableError(
          `Embedding endpoint returned ${response.status}: ${detail}`,
        );
      }

      lastError = new Error(`Embedding endpoint returned ${response.status}`);
    } catch (error) {
      // Re-throw typed errors immediately; only retry on transport-level failures.
      if (error instanceof EmbeddingUnavailableError) throw error;
      lastError = error;
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Embedding request failed after ${MAX_RETRIES} attempts`);
}

/**
 * OpenAI-compatible embedding response returned by the Duet gateway.
 */
interface EmbeddingResponseEnvelope {
  data: Array<{ embedding: number[] }>;
  model: string;
}

function resolveApiKey(override: CreateEmbeddingClientOptions["apiKey"]): string | undefined {
  if (typeof override === "function") return override();
  if (typeof override === "string") return override;
  return process.env.DUET_API_KEY;
}

function resolveEmbeddingModel(): string {
  return process.env[DUET_EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_DUET_EMBEDDING_MODEL;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
