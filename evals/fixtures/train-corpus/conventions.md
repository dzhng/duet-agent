# Fernweb Conventions

- Prefer the platform `fetch` over `axios` for all HTTP calls. Edge runtimes
  do not ship a Node-compatible `http` module, and `axios` pulls one in.
- Store all timestamps as unix milliseconds (integer). Never persist a
  formatted date string.
- Feed item IDs are always lowercase ULIDs. Reject any ID that does not
  match `^[0-9a-hjkmnp-tv-z]{26}$` at the ingest boundary.
- Edge workers must respond within 50ms p95. If a handler needs longer,
  enqueue the work to the ingest pipeline and return a cached response.
- Logs use structured JSON with a `shard_id` field on every line so we can
  trace a request across regions.
