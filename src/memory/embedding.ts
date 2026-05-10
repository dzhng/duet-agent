import { resolveDuetAppBaseUrl } from "../lib/duet-app-url.js";

/**
 * Client for the Duet embedding endpoint.
 *
 * Routes through the Duet public API (`POST <app>/api/v1/embed`) gated
 * by the user's existing `DUET_API_KEY`. Logged-in users get embeddings
 * for free as a CLI perk; we deliberately do not expose a way to plug
 * in a different provider key here so the runtime stays single-path.
 *
 * Behavior:
 *   - Inputs are batched up to `EMBEDDING_BATCH_LIMIT` per HTTP call so
 *     a single backfill batch never goes over the request body cap.
 *   - 5xx responses and network errors retry with exponential backoff;
 *     4xx responses (auth, malformed) fail fast since retrying will not
 *     change the outcome.
 *   - When `DUET_API_KEY` is missing the function throws a typed error
 *     so callers can degrade to keyword-only retrieval (the recall_memory
 *     tool catches it and logs once; the backfill worker logs and
 *     sleeps until the user logs in).
 */

/** Default embedding model identifier sent with every request. */
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
/** Maximum input strings sent in a single embedding request. */
export const EMBEDDING_BATCH_LIMIT = 100;

const ENDPOINT_PATH = "/api/v1/embed";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Callable shape consumed by the backfill worker and the recall_memory
 * tool. Inputs map 1:1 to output vectors.
 */
export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface CreateEmbeddingClientOptions {
  /** Embedding model identifier sent with each request. */
  model?: string;
  /**
   * Override the API key resolver. Defaults to reading `DUET_API_KEY`
   * from `process.env`. Tests inject a fixed value to exercise the
   * client without touching environment state.
   */
  apiKey?: string | (() => string | undefined);
  /**
   * Override the base URL. Defaults to `resolveDuetAppBaseUrl()` so the
   * client follows the same staging/production routing as the rest of
   * the CLI.
   */
  baseUrl?: string;
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
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl ?? resolveDuetAppBaseUrl();
  const fetchImpl = options.fetch ?? fetch;

  return async (inputs) => {
    if (inputs.length === 0) return [];
    const apiKey = resolveApiKey(options.apiKey);
    if (!apiKey) {
      // Throwing a typed error lets callers branch on graceful
      // degradation without string-matching the message.
      throw new EmbeddingUnavailableError(
        "DUET_API_KEY is not set; embeddings unavailable. Run `duet login` to enable hybrid memory retrieval.",
      );
    }

    const results: number[][] = [];
    for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_LIMIT) {
      const slice = inputs.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
      const vectors = await postBatch({
        url: `${baseUrl}${ENDPOINT_PATH}`,
        apiKey,
        model,
        inputs: slice,
        fetchImpl,
      });
      if (vectors.length !== slice.length) {
        throw new Error(
          `Embedding response length (${vectors.length}) did not match request size (${slice.length})`,
        );
      }
      results.push(...vectors);
    }
    return results;
  };
}

interface PostBatchOptions {
  url: string;
  apiKey: string;
  model: string;
  inputs: string[];
  fetchImpl: typeof fetch;
}

async function postBatch(options: PostBatchOptions): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: options.inputs, model: options.model }),
      });

      if (response.ok) {
        const body = (await response.json()) as EmbeddingResponseBody;
        return body.embeddings;
      }

      // 4xx errors (auth, malformed input) will not improve on retry;
      // surface them immediately so callers see the real cause.
      if (response.status >= 400 && response.status < 500) {
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

interface EmbeddingResponseBody {
  /** Vectors in the same order as `input`. */
  embeddings: number[][];
  /** Echoed model identifier so callers can verify the server agreed with their request. */
  model?: string;
}

function resolveApiKey(override: CreateEmbeddingClientOptions["apiKey"]): string | undefined {
  if (typeof override === "function") return override();
  if (typeof override === "string") return override;
  return process.env.DUET_API_KEY;
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
