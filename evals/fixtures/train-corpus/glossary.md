# Fernweb Glossary

- **Fernweb Shard**: the per-user slice of state held on a single edge
  worker. Each shard owns one user's unread set, read positions, and
  pinned items. Shards are pinned to a home region but can be hydrated
  on demand in any region.

- **Ripple Cache**: the regional cache layer that sits between edge
  workers and the origin store. The ripple cache replicates writes
  outward from the ingest pipeline in concentric rings, so popular items
  reach far regions within ~200ms of publish.

- **Drift Window**: the maximum amount of time (currently 90 seconds) an
  edge worker is allowed to serve a stale shard before it must
  re-hydrate from the ripple cache. Exceeding the drift window without
  re-hydrating is a hard error.
