/**
 * Client for the Duet embedding endpoint. Routes through the public API
 * (`POST https://duet.so/api/v1/embed`) gated by the user's existing
 * `DUET_API_KEY` so logged-in users get embeddings without configuring a
 * second provider key.
 *
 * The client batches up to 100 inputs per request, retries with
 * exponential backoff on 5xx responses and network errors, and
 * gracefully degrades when the API key is missing or the endpoint is
 * unreachable: callers see one logged warning, then `recall_memory`
 * falls back to keyword-only search instead of crashing the turn.
 *
 * Concrete request/response shape implemented in commit 6.
 */

/** Default embedding model identifier sent with every backfill batch. */
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
/** Vector dimensionality for `DEFAULT_EMBEDDING_MODEL`; matches the column type in migration v3. */
export const DEFAULT_EMBEDDING_DIMENSION = 1536;
/** Maximum input strings sent in a single embedding request. */
export const EMBEDDING_BATCH_LIMIT = 100;

/**
 * Callable shape consumed by the backfill worker and the recall_memory
 * tool. Inputs map 1:1 to output vectors. Errors propagate so callers
 * can implement their own degradation policy (the worker logs and
 * sleeps; the tool falls back to keyword-only).
 */
export type EmbedFn = (inputs: string[]) => Promise<number[][]>;
